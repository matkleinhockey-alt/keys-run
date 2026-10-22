/**
 * The small print of a storefront: the hand-lettered notice taped inside the window, and the hours plate
 * by the door.
 *
 * ## Why an atlas, not more facade paint
 * Facades are painted at 24 px/m and rendered at 40 (see paint.ts). A notice is 0.46 m wide: 18 pixels. Its
 * lettering would be a smear from anywhere you could read it, which is the whole point of a notice.
 * So the notices are painted on their own canvas at 256 px per notice (~550 px/m) and drawn as ONE merged
 * mesh of small quads sampling it: ONE draw call and one 2048 x 1024 texture (8 MB) for every notice and
 * plate in town, sharp up to arm's length. Things you walk up to and read are the one place resolution is
 * spent.
 *
 * The text is the kind of thing that is on a real Keys storefront, a little rueful: the bar's rules
 * ("NO SHIRT NO SHOES NO PROBLEM"), the pawn shop that buys your old boat, the dryers that are out of
 * order. Nothing here is a brand or a real business.
 */
import * as THREE from 'three';
import { PAD_Y, type Lot } from '@keysrun/shared/world/town';
import type { FacadeTex } from './paint.js';
import { Zf } from './props.js';

const PAPER: Partial<Record<Lot['style'], readonly string[]>> = {
  tackle: ['LIVE', 'SHRIMP', '$14 / DOZ'],
  liquor: ['LOTTO', 'JACKPOT', '$41 MILLION'],
  bar: ['NO SHIRT', 'NO SHOES', 'NO PROBLEM'],
  gifts: ['SHELLS', '3 for $10', 'DO NOT TOUCH', 'THE CONCH'],
  pawn: ['WE BUY', 'GOLD', '& YOUR OLD', 'BOAT'],
  laundromat: ['OUT OF', 'ORDER', '(THE DRYERS)'],
  icecream: ['CASH ONLY', 'SORRY'],
  convenience: ['ATM INSIDE', '$3.50 FEE', '(WE KNOW)'],
  dive: ['AIR FILLS', '$8', 'PARROT DOES', 'NOT BITE'],
  motel: ['NO', 'VACANCY', '(WE LIED)'],
  diner: ['HELP', 'WANTED', 'ASK FOR DEBBIE'],
};
const PLATE: Partial<Record<Lot['style'], readonly string[]>> = {
  tackle: ['OPEN 5AM', 'BAIT FRESH'], guns: ['OPEN', '10 - 6'], liquor: ['OPEN', '9AM - 2AM'], bar: ['OPEN', '11AM - 2AM', '21+'],
  gifts: ['OPEN', '9 - 9'], pawn: ['OPEN', 'MON - SAT'], laundromat: ['24 HRS', 'WASH DRY FOLD'], icecream: ['OPEN', 'NOON - DUSK'],
  convenience: ['OPEN 24', 'HOURS'], dive: ['OPEN', '7 - 5'], motel: ['OFFICE', 'RING BELL'], diner: ['OPEN', '6AM - 3PM'],
};

const HAND = '"Marker Felt", "Bradley Hand", "Segoe Print", "Comic Sans MS", "Chalkboard SE", cursive';
const SANS = '"Big Shoulders Display", Impact, "Arial Narrow", sans-serif';
const TILE = 256, COLS = 8, ROWS = 4;

interface Quad { cx: number; cy: number; cz: number; w: number; h: number; tile: number; plate: boolean }

export interface Notices {
  /** Queue the notice and plate for `lot`, whose facade was painted with `layout`. */
  add(lot: Lot, layout: FacadeTex['layout']): void;
  /** Paint the atlas and build the one mesh. Returns what to dispose. */
  build(near: THREE.Group): { dispose(): void };
}

export function createNotices(): Notices {
  const quads: Quad[] = [];
  const draws: Array<(g: CanvasRenderingContext2D, x: number, y: number) => void> = [];

  function paper(lines: readonly string[], seed: number): (g: CanvasRenderingContext2D, x: number, y: number) => void {
    return (g, x, y) => {
      g.save(); g.translate(x + TILE / 2, y + TILE / 2); g.rotate(((seed * 37) % 9 - 4) * 0.014);
      g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
      g.fillStyle = '#f1ead4'; g.fillRect(-100, -118, 200, 236);
      g.shadowColor = 'transparent';
      // a fold and a coffee ring: it has been up since March
      g.strokeStyle = 'rgba(120,100,70,0.18)'; g.lineWidth = 2; g.beginPath(); g.moveTo(-100, 4); g.lineTo(100, 4); g.stroke();
      g.strokeStyle = 'rgba(110,80,50,0.16)'; g.lineWidth = 4; g.beginPath(); g.arc(52, 74, 20, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#1d2a4a'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const n = lines.length, step = 204 / n;
      lines.forEach((s, i) => {
        const big = i === 0 || (n > 3 && i === 1) || /^\$|^NO |^OUT|^WE |^HELP/.test(s);
        g.font = `${big ? 800 : 700} ${big ? 50 : 34}px ${HAND}`;
        g.save(); g.translate(0, -102 + step * (i + 0.5)); g.rotate((((i * 53 + seed) % 5) - 2) * 0.012);
        g.fillText(s, 0, 0, 184);
        g.restore();
      });
      // tape, top corners
      g.fillStyle = 'rgba(235,225,180,0.75)';
      g.save(); g.translate(-96, -116); g.rotate(-0.6); g.fillRect(-22, -7, 44, 14); g.restore();
      g.save(); g.translate(96, -116); g.rotate(0.6); g.fillRect(-22, -7, 44, 14); g.restore();
      g.restore();
    };
  }

  function plate(lines: readonly string[]): (g: CanvasRenderingContext2D, x: number, y: number) => void {
    return (g, x, y) => {
      // an engraved plastic plate, white on dark blue, screws in the corners, in the top half of its tile
      g.save(); g.translate(x, y);
      g.fillStyle = '#122a47'; g.fillRect(8, 8, TILE - 16, TILE / 2 - 8);
      g.strokeStyle = '#d9dde0'; g.lineWidth = 4; g.strokeRect(14, 14, TILE - 28, TILE / 2 - 20);
      g.fillStyle = '#9aa0a6'; for (const [sx, sy] of [[22, 22], [TILE - 22, 22], [22, TILE / 2 - 14], [TILE - 22, TILE / 2 - 14]] as const) { g.beginPath(); g.arc(sx, sy, 4, 0, 7); g.fill(); }
      g.fillStyle = '#f4f1e8'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const n = lines.length, step = (TILE / 2 - 40) / n;
      lines.forEach((s, i) => { g.font = `800 ${i === 0 ? 44 : 30}px ${SANS}`; g.fillText(s, TILE / 2, 28 + step * (i + 0.5), TILE - 56); });
      g.restore();
    };
  }

  return {
    add(lot, L): void {
      if (lot.style === 'club') return; // not ours to touch
      const { door, windows } = L;
      const z = Zf(lot.v0) + 0.075;
      const p = PLATE[lot.style];
      if (p) {
        const tile = draws.length; draws.push(plate(p));
        quads.push({ cx: lot.u0 + door.x + door.w + 0.24, cy: PAD_Y + 1.5, cz: z, w: 0.34, h: 0.17, tile, plate: true });
      }
      const text = PAPER[lot.style];
      if (text && windows.length) {
        // the first pane to the right of the door (the one you walk past as you come in), else the last
        const right = windows.filter((w) => w.x > door.x);
        const win = right[0] ?? windows[windows.length - 1];
        const tile = draws.length; draws.push(paper(text, lot.id.length * 7 + Math.floor(lot.u0)));
        quads.push({ cx: lot.u0 + win.x + 0.32, cy: PAD_Y + win.y + 0.42, cz: z, w: 0.46, h: 0.46, tile, plate: false });
      }
    },

    build(near): { dispose(): void } {
      const c = document.createElement('canvas'); c.width = TILE * COLS; c.height = TILE * ROWS;
      const g = c.getContext('2d')!;
      draws.forEach((d, i) => d(g, (i % COLS) * TILE, Math.floor(i / COLS) * TILE));
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
      for (const q of quads) {
        const col = q.tile % COLS, row = Math.floor(q.tile / COLS);
        const u0 = col / COLS, u1 = (col + 1) / COLS;
        // canvas y runs down, texture v up: the top of tile `row` is v = 1 - row/ROWS. A plate occupies the TOP half of its tile.
        const vTop = 1 - row / ROWS, v1 = q.plate ? vTop - 0.5 / ROWS : vTop - 1 / ROWS;
        const base = pos.length / 3, hw = q.w / 2, hh = q.h / 2;
        pos.push(q.cx - hw, q.cy - hh, q.cz, q.cx + hw, q.cy - hh, q.cz, q.cx + hw, q.cy + hh, q.cz, q.cx - hw, q.cy + hh, q.cz);
        uv.push(u0, v1, u1, v1, u1, vTop, u0, vTop);
        for (let k = 0; k < 4; k++) nor.push(0, 0, 1);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, roughness: 0.85, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
      const mesh = new THREE.Mesh(geo, mat); mesh.name = 'notices'; mesh.receiveShadow = true;
      near.add(mesh);
      return { dispose(): void { geo.dispose(); mat.dispose(); t.dispose(); } };
    },
  };
}
