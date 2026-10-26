/**
 * Lateral navigation marks on the dredged channels.
 *
 * The chain already has real cuts through it — `CHANNELS` (the shallow cuts between the keys,
 * given relative to `chainZ`) and `MIAMI_CH` (the deep ship channels up north) — but nothing
 * marked them, so a channel was something you found by running aground beside it. These put a
 * line of buoys down each side of every cut, which is what makes a channel navigable: you read
 * the water by the marks rather than by the depth sounder.
 *
 * US lateral convention (IALA Region B, "red right returning"): coming in from seaward, red
 * marks are to starboard and green to port. Seaward here is offshore, which is +z — the ocean
 * side of the chain — so a boat heading in (-z) keeps red to starboard, i.e. red sits on the
 * larger-x side of a cut running north-south, and on the smaller... that depends on the cut's
 * own axis, so `side` is resolved per channel from its long axis below rather than assumed.
 *
 * Pure data: no three.js, no DOM, same shape as the rest of `world/**`, so the client can build
 * meshes from it and a test can assert the marks land in the water they are supposed to mark.
 */
import { CHANNELS, MIAMI_CH, depthAt, type Channel, type MiamiChannel } from './depth.js';
import { chainZ } from './chain.js';

/** Which hand of the channel a mark stands on, entering from seaward. */
export type MarkHand = 'red' | 'green';

export interface ChannelMark {
  x: number;
  z: number;
  hand: MarkHand;
  /** 1, 2, 3 … up the channel from its seaward end. Reds are even and greens odd, as they are
   * on a real chart, so a pair reads "2 and 3" rather than both carrying the same number. */
  n: number;
  /** The channel's charted depth in metres, for the mark's own label and for sizing. */
  depth: number;
}

/** Marks sit this far in from the dredged edge: inside the shoal, not in the fairway. */
export const MARK_INSET_M = 6;
/** Roughly one pair per this much channel length. A cut only a couple of hundred metres long
 * still gets two pairs, or it is not marked so much as decorated. */
export const MARK_SPACING_M = 150;

function marksForRect(x0: number, x1: number, z0: number, z1: number, depth: number, startN: number): ChannelMark[] {
  const out: ChannelMark[] = [];
  const w = Math.abs(x1 - x0), h = Math.abs(z1 - z0);
  // The long axis is the direction you travel; marks go down the two long sides.
  const alongZ = h >= w;
  const length = alongZ ? h : w;
  const pairs = Math.max(2, Math.round(length / MARK_SPACING_M));
  const loX = Math.min(x0, x1), hiX = Math.max(x0, x1);
  const loZ = Math.min(z0, z1), hiZ = Math.max(z0, z1);
  // Inset is capped so a narrow cut's marks never cross over each other into the fairway.
  const halfW = (alongZ ? hiX - loX : hiZ - loZ) / 2;
  const inset = Math.min(MARK_INSET_M, Math.max(0.5, halfW * 0.35));
  let n = startN;
  for (let i = 0; i < pairs; i++) {
    // Seaward (+z, or +x on an east-west cut) first, working inward.
    const u = pairs === 1 ? 0.5 : i / (pairs - 1);
    const t = 1 - u;
    const along = alongZ ? loZ + (hiZ - loZ) * t : loX + (hiX - loX) * t;
    const edgeA = (alongZ ? loX : loZ) + inset;
    const edgeB = (alongZ ? hiX : hiZ) - inset;
    // Entering from seaward, starboard is the right hand — which for a northbound (-z) run is
    // the smaller-x side, and for a westbound (-x) run is the larger-z side.
    const redOnLow = alongZ;
    const red = redOnLow ? edgeA : edgeB;
    const green = redOnLow ? edgeB : edgeA;
    if (alongZ) {
      out.push({ x: red, z: along, hand: 'red', n: n * 2, depth });
      out.push({ x: green, z: along, hand: 'green', n: n * 2 + 1, depth });
    } else {
      out.push({ x: along, z: red, hand: 'red', n: n * 2, depth });
      out.push({ x: along, z: green, hand: 'green', n: n * 2 + 1, depth });
    }
    n++;
  }
  return out;
}

/**
 * A mark has to float. The cuts are rectangles and the chain is not, so an edge can fall on a key
 * — 15 of the first 68 generated marks stood on dry land, which is worse than leaving the channel
 * unmarked. Anything not in navigable water is dropped rather than nudged: moving it would put it
 * somewhere that is not the channel edge, and a mark in the wrong place is a hazard, not an aid.
 */
export const MARK_MIN_DEPTH_M = 1;

/** Every lateral mark in the world, in a stable order. */
export function channelMarks(
  cuts: readonly Channel[] = CHANNELS,
  deep: readonly MiamiChannel[] = MIAMI_CH,
): ChannelMark[] {
  const out: ChannelMark[] = [];
  let n = 1;
  for (const c of cuts) {
    const z0 = chainZ(c.x0) + c.dz0, z1 = chainZ(c.x1) + c.dz1;
    const m = marksForRect(c.x0, c.x1, z0, z1, c.d, n);
    n += m.length / 2;
    out.push(...m);
  }
  for (const c of deep) {
    const m = marksForRect(c.x0, c.x1, c.z0, c.z1, c.d, n);
    n += m.length / 2;
    out.push(...m);
  }
  return out.filter((k) => depthAt(k.x, k.z) >= MARK_MIN_DEPTH_M);
}
