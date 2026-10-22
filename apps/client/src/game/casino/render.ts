/**
 * Draws the cabinet: marquee, three reels scrolled from the pre-rendered strips, win lines and the
 * win banner. Pure canvas, no state of its own: `index.ts` hands it everything each frame.
 *
 * Layout (CSS px, 420 x 326): a 62 px marquee, then three 118 x 246 reel windows with 8 px between.
 */
import { LINES, ROWS, REELS, REEL_LEN, type LineWin } from '@keysrun/shared/sim/slots';
import type { ReelSet } from '@keysrun/shared/sim/reels';
import { CELL_H, CELL_W, type Strips } from './art.js';

export const CAB_W = 420;
export const CAB_H = 326;
const GAP = 8;
const X0 = (CAB_W - (REELS * CELL_W + (REELS - 1) * GAP)) / 2;
const Y0 = 64;
const WIN_H = ROWS * CELL_H;
const LINE_COLORS = ['#ffd23f', '#ff5a8a', '#46d9ff', '#7dff8a', '#ff9d3b'];

export interface Frame {
  t: number;
  strips: Strips;
  theme: string;
  /** Resting stops (used when `reels` is null). */
  rest: readonly number[];
  reels: ReelSet | null;
  /** Reel being teased (near-miss) while it is still moving. */
  tease: number | null;
  win: { lines: readonly LineWin[]; amount: number; kind: string; shown: number; age: number } | null;
  bet: number;
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

export function drawCabinet(g: CanvasRenderingContext2D, f: Frame): void {
  const { strips } = f, sc = strips.scale;
  g.save();
  g.clearRect(0, 0, CAB_W, CAB_H);
  // body
  const body = g.createLinearGradient(0, 0, 0, CAB_H);
  body.addColorStop(0, '#12445e'); body.addColorStop(0.5, '#0a2433'); body.addColorStop(1, '#06141d');
  g.fillStyle = body; rr(g, 0, 0, CAB_W, CAB_H, 18); g.fill();
  g.strokeStyle = '#e0b34a'; g.lineWidth = 3; rr(g, 3, 3, CAB_W - 6, CAB_H - 6, 16); g.stroke();

  // marquee: the name, and a chase of bulbs
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '800 30px "Big Shoulders Display", Impact, sans-serif';
  g.shadowColor = '#ff5aa8'; g.shadowBlur = 14;
  g.fillStyle = '#ffd1ea'; g.fillText(f.theme.toUpperCase(), CAB_W / 2, 32, CAB_W - 70);
  g.shadowBlur = 0;
  const bulbs = 22;
  for (let i = 0; i < bulbs; i++) {
    const on = (Math.floor(f.t * (f.reels ? 14 : 3)) + i) % 3 === 0;
    g.fillStyle = on ? '#fff3b0' : '#7a6a2c';
    if (on) { g.shadowColor = '#ffd23f'; g.shadowBlur = 8; }
    g.beginPath(); g.arc(18 + i * ((CAB_W - 36) / (bulbs - 1)), 10, 3, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
  }

  // reels
  for (let r = 0; r < REELS; r++) {
    const x = X0 + r * (CELL_W + GAP);
    g.save();
    rr(g, x - 3, Y0 - 3, CELL_W + 6, WIN_H + 6, 8); g.fillStyle = '#05101a'; g.fill();
    g.beginPath(); g.rect(x, Y0, CELL_W, WIN_H); g.clip();
    const view = f.reels ? f.reels.view(r) : { top: ((f.rest[r] % REEL_LEN) + REEL_LEN) % REEL_LEN };
    const speed = f.reels ? f.reels.speed(r) : 0;
    const blurA = Math.max(0, Math.min(1, (speed - 5) / 9));
    const stripH = CELL_H * REEL_LEN;
    const sy = view.top * CELL_H;
    const piece = (img: HTMLCanvasElement, alpha: number): void => {
      if (alpha <= 0) return;
      g.globalAlpha = alpha;
      const h1 = Math.min(WIN_H, stripH - sy);
      g.drawImage(img, 0, sy * sc, CELL_W * sc, h1 * sc, x, Y0, CELL_W, h1);
      if (h1 < WIN_H) g.drawImage(img, 0, 0, CELL_W * sc, (WIN_H - h1) * sc, x, Y0 + h1, CELL_W, WIN_H - h1);
      g.globalAlpha = 1;
    };
    piece(strips.sharp[r], 1 - blurA * 0.92);
    piece(strips.blur[r], blurA);
    // depth: the drum curves away top and bottom
    const sh = g.createLinearGradient(0, Y0, 0, Y0 + WIN_H);
    sh.addColorStop(0, 'rgba(0,0,0,0.55)'); sh.addColorStop(0.2, 'rgba(0,0,0,0)'); sh.addColorStop(0.8, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = sh; g.fillRect(x, Y0, CELL_W, WIN_H);
    g.restore();
    // the tease: the last reel is held, the two before it glow
    if (f.tease !== null && f.reels && f.reels.phase(f.tease) !== 'stopped' && r < f.tease) {
      g.strokeStyle = `rgba(255,210,63,${0.5 + 0.5 * Math.sin(f.t * 14)})`; g.lineWidth = 3;
      rr(g, x - 3, Y0 - 3, CELL_W + 6, WIN_H + 6, 8); g.stroke();
    }
    if (f.tease === r && f.reels && (f.reels.phase(r) === 'stopping' || f.reels.phase(r) === 'spinning') && f.reels.t > 1.4) {
      g.strokeStyle = `rgba(255,90,138,${0.55 + 0.45 * Math.sin(f.t * 20)})`; g.lineWidth = 4;
      rr(g, x - 3, Y0 - 3, CELL_W + 6, WIN_H + 6, 8); g.stroke();
    }
  }

  // line tabs at the edges
  g.font = '800 11px system-ui, sans-serif';
  const tabRows = [1, 0, 2];
  tabRows.forEach((row, i) => {
    for (const side of [0, 1]) {
      const cx = side ? CAB_W - 11 : 11, cy = Y0 + row * CELL_H + CELL_H / 2;
      g.fillStyle = LINE_COLORS[i]; g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#10202c'; g.fillText(String(i + 1), cx, cy + 0.5);
    }
  });

  // winning lines
  if (f.win && !f.reels) {
    const pulse = 0.6 + 0.4 * Math.sin(f.win.age * 9);
    for (const w of f.win.lines) {
      const ln = LINES[w.line], col = LINE_COLORS[w.line % LINE_COLORS.length];
      const pts = ln.map((row, r) => [X0 + r * (CELL_W + GAP) + CELL_W / 2, Y0 + row * CELL_H + CELL_H / 2] as const);
      g.strokeStyle = col; g.lineWidth = 5; g.globalAlpha = pulse; g.shadowColor = col; g.shadowBlur = 12; g.lineJoin = 'round';
      g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
      g.shadowBlur = 0; g.lineWidth = 3;
      const n = w.count === 2 ? 2 : 3;
      for (let r = 0; r < n; r++) { rr(g, X0 + r * (CELL_W + GAP) + 3, Y0 + ln[r] * CELL_H + 3, CELL_W - 6, CELL_H - 6, 8); g.stroke(); }
      g.globalAlpha = 1;
    }
    // the banner
    if (f.win.amount > 0) {
      const big = f.win.kind === 'jackpot' || f.win.kind === 'big';
      const by = Y0 + WIN_H / 2, bw = 250, bh = big ? 62 : 46;
      g.save();
      g.globalAlpha = Math.min(1, f.win.age * 4) * 0.94;
      const bg = g.createLinearGradient(0, by - bh / 2, 0, by + bh / 2);
      bg.addColorStop(0, f.win.kind === 'jackpot' ? '#ff3f8a' : '#1b6a8c'); bg.addColorStop(1, '#06141d');
      g.fillStyle = bg; rr(g, CAB_W / 2 - bw / 2, by - bh / 2, bw, bh, 12); g.fill();
      g.strokeStyle = '#ffd23f'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#fff3b0'; g.shadowColor = '#ffd23f'; g.shadowBlur = 12;
      g.font = `800 ${big ? 34 : 26}px "Big Shoulders Display", Impact, sans-serif`;
      g.fillText(`${f.win.kind === 'jackpot' ? 'MARLIN! ' : 'WIN '}$${Math.round(f.win.shown).toLocaleString('en-US')}`, CAB_W / 2, by + 1, bw - 20);
      g.restore();
    }
  }
  g.restore();
}
