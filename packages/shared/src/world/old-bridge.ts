/**
 * The Old Seven Mile Bridge as a fishing pier, which is what the real one has been since 1982:
 * its deck, where apps/client/src/world/bridge.ts draws it, is walkable and fished off, and a
 * ramp at each end of a span that comes down onto a key lets you walk up from the land.
 *
 * The deck segments are defined here and drawn from this list by apps/client/src/world/bridge.ts:
 * STEP-metre segments along `chainZ(x) + OLDBR.dz` from OLDBR.x0, none across the navigation gap,
 * none over land (`shoreInfo(..).d < 1`); the renderer makes each `len + 0.4` long and 7.5 m wide
 * with its top at OLD_DECK_TOP.
 */
import { chainZ, shoreInfo } from './chain.js';
import { landH, OLDBR } from './depth.js';

/** bridge.ts: deck centre 5.0 m, 0.8 m thick. */
export const OLD_DECK_TOP = 5.4;
/** bridge.ts: 7.5 m wide; the walkable part stops short of the edge. */
const WALK_HALF = 3.4;
const STEP = 24;
/** A ramp: 4 m wide, a gentle 1 in 9, down onto the land. */
const RAMP_HALF = 2;
const RAMP_SLOPE = 1 / 9;

export interface DeckSeg { xa: number; za: number; xb: number; zb: number }
export interface Ramp {
  /** The top, where it leaves the deck, and the unit direction down it. */
  x0: number; z0: number; dx: number; dz: number;
  len: number;
  /** Ground height at the foot. */
  foot: number;
}

function buildSpans(): { segs: DeckSeg[]; ramps: Ramp[] } {
  const segs: DeckSeg[] = [];
  const all: Array<{ xa: number; xb: number; deck: boolean; gap: boolean }> = [];
  for (let x = OLDBR.x0; x < OLDBR.x1; x += STEP) {
    const xa = x, xb = x + STEP;
    const gap = xb > OLDBR.gap[0] && xa < OLDBR.gap[1];
    const za = chainZ(xa) + OLDBR.dz, zb = chainZ(xb) + OLDBR.dz;
    const deck = !gap && shoreInfo((xa + xb) / 2, (za + zb) / 2).d >= 1;
    all.push({ xa, xb, deck, gap });
    if (deck) segs.push({ xa, za, xb, zb });
  }
  // Where a span ends at a key (deck, then land), a ramp runs on down onto it — if the key is
  // long enough to take one and dry at its foot.
  const ramps: Ramp[] = [];
  const tryRamp = (xEdge: number, dir: 1 | -1) => {
    const z0 = chainZ(xEdge) + OLDBR.dz;
    const x1 = xEdge + dir * 10, z1 = chainZ(x1) + OLDBR.dz;
    const l = Math.hypot(x1 - xEdge, z1 - z0), dx = (x1 - xEdge) / l, dz = (z1 - z0) / l;
    // walk down at RAMP_SLOPE until the ramp meets the ground
    for (let s = 4; s <= 80; s += 1) {
      const x = xEdge + dx * s, z = z0 + dz * s, g = landH(x, z), y = OLD_DECK_TOP - s * RAMP_SLOPE;
      if (g < 0.3 && s > 6) return; // off the end of the key: no ramp here
      if (y <= g) { ramps.push({ x0: xEdge, z0, dx, dz, len: s, foot: g }); return; }
    }
  };
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i], b = all[i + 1];
    if (a.deck && !b.deck && !b.gap) tryRamp(a.xb + 0.2, 1);
    if (!a.deck && !a.gap && b.deck) tryRamp(b.xa - 0.2, -1);
  }
  return { segs, ramps };
}

const SPANS = buildSpans();
export const OLD_DECK_SEGS: readonly DeckSeg[] = SPANS.segs;
export const OLD_RAMPS: readonly Ramp[] = SPANS.ramps;

/** On the old bridge's deck itself (not a ramp)? */
export function onOldDeck(x: number, z: number): boolean {
  if (x < OLDBR.x0 - 1 || x > OLDBR.x1 + 1) return false;
  const i = Math.floor((x - OLDBR.x0) / STEP);
  for (const k of [i - 1, i, i + 1]) {
    const s = OLD_DECK_SEGS.find((q) => q.xa === OLDBR.x0 + k * STEP);
    if (!s) continue;
    const ux = s.xb - s.xa, uz = s.zb - s.za, L = Math.hypot(ux, uz);
    const a = ((x - s.xa) * ux + (z - s.za) * uz) / L, c = (-(x - s.xa) * uz + (z - s.za) * ux) / L;
    if (a >= -0.2 && a <= L + 0.2 && Math.abs(c) <= WALK_HALF) return true;
  }
  return false;
}

/** Height of the old bridge's deck or one of its ramps under (x,z), or null. */
export function oldBridgeGround(x: number, z: number): number | null {
  if (onOldDeck(x, z)) return OLD_DECK_TOP;
  for (const r of OLD_RAMPS) {
    const ax = x - r.x0, az = z - r.z0;
    const s = ax * r.dx + az * r.dz, c = -ax * r.dz + az * r.dx;
    if (s >= -0.3 && s <= r.len && Math.abs(c) <= RAMP_HALF) return OLD_DECK_TOP + (r.foot - OLD_DECK_TOP) * Math.max(0, s) / r.len;
  }
  return null;
}
