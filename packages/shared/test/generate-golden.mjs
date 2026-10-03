#!/usr/bin/env node
// @ts-nocheck
/**
 * Generates packages/shared/test/golden.json: the fidelity fixture that proves the TypeScript
 * port in packages/shared/src/world and packages/shared/src/waves reproduces legacy/index.html
 * exactly.
 *
 * How it works: this script reads legacy/index.html, slices out the *original* source lines for
 * chainZ/shoreInfo/depthAt/landH/zoneAt/offshoreF/creekDist (index.html:323, 326-432) and the
 * pure wave-sum loop body (index.html:443), evaluates that extracted source in Node with
 * `new Function(...)`, and records its outputs over a large, deterministic sample set. It does
 * NOT import anything from src/ — it is an independent oracle built straight from the legacy
 * file, so it can't accidentally pass by sharing a bug with the port.
 *
 * Verified by inspection (and asserted below) that none of these extracted lines touch
 * THREE/DOM/window/document: they are plain closed-form math + array literals. The one function
 * that *does* touch three.js, legacy's `waveH` (index.html:442-444), is deliberately NOT
 * extracted whole — only its inner loop (line 443) is reused, wrapped in a new `waveHBaseRef`
 * that returns `amp*h` instead of `amp*h+wakeH(x,z,t)`. See docs/ARCHITECTURE.md and
 * packages/shared/src/waves/index.ts's doc comment for why.
 *
 * Run with: node packages/shared/test/generate-golden.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_PATH = path.resolve(HERE, '../../../legacy/index.html');
const OUT_PATH = path.resolve(HERE, 'golden.json');

const SRC_LINES = fs.readFileSync(LEGACY_PATH, 'utf8').split('\n');
/** 1-indexed, inclusive, like the task's "source lines" column. */
const slice = (a, b) => SRC_LINES.slice(a - 1, b).join('\n');

function assertPure(label, src) {
  const banned = ['THREE', 'wakeH', 'wakeP', 'document.', 'window.', 'performance.'];
  for (const token of banned) {
    if (src.includes(token)) {
      throw new Error(`generate-golden: extracted block "${label}" unexpectedly contains "${token}" — it is not pure, stub it before trusting this fixture.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 1. chainZ / islands / shoreInfo / depthAt / landH / zoneAt / offshoreF / creekDist
//    index.html:323 (clamp/lerp/rand) + index.html:326-432 (world shape + bathymetry), verbatim,
//    unmodified, in original order. This is a single contiguous block in the original file, so
//    no reordering is needed for its internal load-order dependencies (islands before shoreInfo,
//    GOLF/RUNWAY before onCourse, etc.) — plain top-to-bottom script evaluation already matches
//    the original <script> tag's evaluation order.
const chainDepthSrc = slice(323, 323) + '\n' + slice(326, 432);
assertPure('chain+depth (index.html:323,326-432)', chainDepthSrc);

const chainDepth = new Function(`
${chainDepthSrc}
return { chainZ, islands, islandLocal, islandWorld, shoreInfo, onCourse, landH, offshoreF, depthAt,
  nearBridge, nearHump, zoneAt, HUMPS, CHANNELS, MIAMI_CH, MARINAS, CREEKS, GOLF, RUNWAY, OLDBR,
  WORLD, WB, ZONE_DESC, creekDist, VACA, KCB };
`)();

// ---------------------------------------------------------------------------------------------
// 2. waveHBase: the pure 8-component wave sum, index.html:440-441 (WAVES) + 443 (the loop body),
//    with the wake term (`+wakeH(x,z,t)`, index.html:444) deliberately dropped. `SW`/`CH` were
//    legacy module-scope mutable `let`s (index.html:435) that line 443 reads via closure; here
//    they're ordinary parameters so the extracted loop body needs no other change.
const WAVE_LOOP_LINE = slice(443, 443);
assertPure('wave loop body (index.html:443)', WAVE_LOOP_LINE);
if (!WAVE_LOOP_LINE.includes('WAVES[i]') || !WAVE_LOOP_LINE.includes('Math.sin(p)-W[4]*Math.cos(2*p)')) {
  throw new Error('generate-golden: index.html:443 did not match the expected wave-sum loop body — legacy file changed underneath this script.');
}
const wavesSrc = slice(440, 441);
const waves = new Function(`
${wavesSrc}
function waveHBaseRef(x, z, t, amp, SW, CH) {
  let h = 0;
  ${WAVE_LOOP_LINE}
  return amp * h;
}
return { WAVES, waveHBaseRef };
`)();

// ---------------------------------------------------------------------------------------------
// Deterministic sampling (a tiny local LCG — no Math.random, no dependency on src/rng).
function makeLcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
const rnd = makeLcg(0xC0FFEE);
const lerpN = (a, b, u) => a + (b - a) * u;

const { WB, HUMPS, CHANNELS, MIAMI_CH, MARINAS, CREEKS, islands, OLDBR } = chainDepth;

function sampleFields(x, z) {
  const si = chainDepth.shoreInfo(x, z);
  const nh = chainDepth.nearHump(x, z);
  return {
    x, z,
    chainZ: chainDepth.chainZ(x),
    depthAt: chainDepth.depthAt(x, z),
    landH: chainDepth.landH(x, z),
    zoneAt: chainDepth.zoneAt(x, z),
    offshoreF: chainDepth.offshoreF(x, z),
    creekDist: chainDepth.creekDist(x, z),
    nearBridge: chainDepth.nearBridge(x, z),
    nearHump: nh ? nh.name : null,
    shoreD: si.d,
    shoreE: si.e,
    shoreIsl: si.isl ? si.isl.name : null,
  };
}

// ---- 60x60 grid spanning the full world bounds WB
const grid = [];
const GN = 60;
for (let j = 0; j < GN; j++) {
  for (let i = 0; i < GN; i++) {
    const x = lerpN(WB.x0, WB.x1, i / (GN - 1));
    const z = lerpN(WB.z0, WB.z1, j / (GN - 1));
    grid.push(sampleFields(x, z));
  }
}

// ---- ~200 hand-picked points of interest
const points = [];
const addPoint = (label, x, z) => points.push({ label, ...sampleFields(x, z) });

// every island centre
for (const I of islands) addPoint(`island-centre:${I.name}`, I.x, I.z);
// both sides of every island's shoreline (just inside / just outside the ellipse, along local +x)
for (const I of islands) {
  for (const e of [0.9, 0.95, 1.0, 1.05, 1.1]) {
    const [wx, wz] = chainDepth.islandWorld(I, I.a * e, 0);
    addPoint(`island-shore:${I.name}:e=${e}`, wx, wz);
  }
}
// every marina: dock anchor and exit point
for (const M of MARINAS) {
  addPoint(`marina-dock:${M.name}`, M.sx, M.sz);
  addPoint(`marina-exit:${M.name}`, M.ex, M.ez);
}
// every hump: centre, inside patch radius, and just past the hump's influence radius
for (const H of HUMPS) {
  const x = H.x, z = chainDepth.chainZ(H.x) + H.dz;
  addPoint(`hump-centre:${H.name}`, x, z);
  addPoint(`hump-near:${H.name}`, x + 50, z + 50);
  addPoint(`hump-far:${H.name}`, x + 500, z + 500);
}
// each Hawk Channel / reef-wall CHANNEL and MIAMI_CH channel: centre point
for (const C of CHANNELS) {
  const x = (C.x0 + C.x1) / 2, dz = (C.dz0 + C.dz1) / 2;
  addPoint(`channel:${C.x0},${C.x1},${C.dz0},${C.dz1}`, x, chainDepth.chainZ(x) + dz);
}
for (const C of MIAMI_CH) {
  addPoint(`miami-channel:${C.x0},${C.x1}`, (C.x0 + C.x1) / 2, (C.z0 + C.z1) / 2);
}
// each creek: start, middle, end of its centerline (exercises creekDist/zoneAt's 'Creek' branch)
for (const C of CREEKS) {
  const picks = [0, Math.floor((C.pts.length - 1) / 2), C.pts.length - 1];
  for (const i of picks) addPoint(`creek:${C.name}:${i}`, C.pts[i][0], C.pts[i][1]);
}
// both sides of every zone-boundary dz threshold (1250/1300/1460/1650), at several x positions,
// and the d thresholds (2.6 shallow/Flats, 45 Offshore) via each formula segment's inverse.
const X_SAMPLES = [-3800, -2500, -1200, 0, 1200, 2500, 3800];
for (const dzBoundary of [1250, 1300, 1460, 1650]) {
  for (const side of [-5, 5]) {
    for (const x of X_SAMPLES) addPoint(`zone-dz:${dzBoundary}:${side}:x=${x}`, x, chainDepth.chainZ(x) + dzBoundary + side);
  }
}
// d=2.6 (Flats threshold) crossings: Bay-side formula 1.4+min(-dz,2600)/2600*3.4=2.6 -> dz=-917.65;
// Hawk-Channel-side formula 2.2+min(dz,520)/520*5.6=2.6 -> dz=37.14 (ignores noise/channel terms,
// which is fine — we just want points straddling the nominal boundary, not the exact crossing).
for (const dzApprox of [-917.6470588235294, 37.142857142857146]) {
  for (const side of [-3, 3]) {
    for (const x of X_SAMPLES) addPoint(`zone-d2.6:${dzApprox.toFixed(1)}:${side}:x=${x}`, x, chainDepth.chainZ(x) + dzApprox + side);
  }
}
// d=45 (Offshore threshold): reef-wall/Gulf-Stream formulas meet at dz=1650 (both give d=45.4),
// so the practical threshold sits essentially right at dz=1650 — already sampled above, but add
// a tighter straddle here too since zoneAt's `d>=45` check is a few lines, not an input, so this
// still exercises a materially different code path (depthAt -> zoneAt's d-based branch).
for (const side of [-1, 1]) {
  for (const x of X_SAMPLES) addPoint(`zone-d45:${side}:x=${x}`, x, chainDepth.chainZ(x) + 1650 + side);
}
// bridge channel: on/off the Seven Mile Bridge (dz~0) and the old bridge's gap (OLDBR)
for (const x of X_SAMPLES) {
  addPoint(`bridge-on:x=${x}`, x, chainDepth.chainZ(x));
  addPoint(`bridge-off:x=${x}`, x, chainDepth.chainZ(x) + 60);
}
addPoint('old-bridge-gap', (OLDBR.gap[0] + OLDBR.gap[1]) / 2, chainDepth.chainZ((OLDBR.gap[0] + OLDBR.gap[1]) / 2) + OLDBR.dz);
addPoint('old-bridge-span', OLDBR.x0 + 100, chainDepth.chainZ(OLDBR.x0 + 100) + OLDBR.dz);
// golf course / runway on Vaca Key (landH's onCourse branch)
{
  const VACA = chainDepth.VACA, KCB = chainDepth.KCB;
  const [gx, gz] = chainDepth.islandWorld(VACA, 300, -30); addPoint('golf:sombrero-cc', gx, gz);
  const [kx, kz] = chainDepth.islandWorld(KCB, 0, 0); addPoint('golf:key-colony', kx, kz);
  const [rx, rz] = chainDepth.islandWorld(VACA, 1000, -150); addPoint('runway:vaca', rx, rz);
}
// a spread of extra fixed, low-structure points for broad coverage (not random per se, but an
// irrational-step walk across WB so it doesn't line up with the grid or any formula boundary)
for (let i = 0; i < 40; i++) {
  const x = WB.x0 + ((i * 2654.17) % (WB.x1 - WB.x0));
  const z = WB.z0 + ((i * 1771.31) % (WB.z1 - WB.z0));
  addPoint(`extra:${i}`, x, z);
}

// ---------------------------------------------------------------------------------------------
// ---- 500 (x,z,t) triples for waveHBase. amp/sw/ch held fixed at waveHBase's documented
//      defaults (1, DEFAULT_SW=0.9, DEFAULT_CH=1) — see packages/shared/src/waves/index.ts.
const AMP = 1, SW = 0.9, CH = 1;
const waveSamples = [];
for (let i = 0; i < 500; i++) {
  const x = lerpN(WB.x0, WB.x1, rnd());
  const z = lerpN(WB.z0, WB.z1, rnd());
  const t = rnd() * 2000;
  waveSamples.push({ x, z, t, amp: AMP, sw: SW, ch: CH, waveHBase: waves.waveHBaseRef(x, z, t, AMP, SW, CH) });
}

// ---- raw island dump, for direct island-construction diagnostics (chain.test.ts)
const islandsDump = islands.map((I) => ({
  name: I.name, x: I.x, z: I.z, a: I.a, b: I.b, th: I.th, c: I.c, s: I.s,
  small: I.small, mainland: !!I.mainland, miami: !!I.miami, noHouses: !!I.noHouses,
}));

const golden = {
  meta: {
    generatedFrom: 'legacy/index.html',
    lines: { utils: '323', chainDepth: '326-432', wavesTable: '440-441', waveLoopBody: '443' },
    islandSeed: 11,
    gridSize: GN,
    pointCount: points.length,
    waveSampleCount: waveSamples.length,
    waveDefaults: { amp: AMP, sw: SW, ch: CH },
  },
  islands: islandsDump,
  grid,
  points,
  waves: waveSamples,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(golden));
console.log(`wrote ${OUT_PATH}`);
console.log(`  grid: ${grid.length} points, hand-picked: ${points.length} points, waves: ${waveSamples.length} samples, islands: ${islandsDump.length}`);
