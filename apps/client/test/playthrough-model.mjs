/**
 * Offline progression model: the same shared sim the game runs (`chooseFish`/`fightParamsFor`/
 * `stepFight`, `airBurnRate`), Monte-Carlo'd thousands of times in plain node.
 *
 * Why this exists next to the browser playthrough (playthrough.mjs): the browser run is the only
 * honest end-to-end check, but this sandbox renders ~3 fps and the game clamps simulated time to
 * 0.05 s per rendered frame, so one real catch costs minutes of wall clock and a whole session
 * yields a handful of samples. Rates ("how often is a fight lost", "what do you catch at the
 * reef") need hundreds of samples. Everything here is SIMULATED seconds, never wall clock, and
 * the numbers it produces are the ones the browser run should land inside; the playthrough
 * report carries both so a divergence flags a bug in one of them.
 *
 * Nothing here imports game source beyond @keysrun/shared; it measures, it does not fix.
 *
 * Usage: node apps/client/test/playthrough-model.mjs [outFile]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xoshiro128ss } from '@keysrun/shared/rng';
import { SPECIES, ZONE_TABLE } from '@keysrun/shared/content/species';
import { MEAT_PRICE, NO_SALE } from '@keysrun/shared/content/economy';
import { BOATS, COOLER_CAP, SPEED_SCALE } from '@keysrun/shared/content/boats';
import { zoneAt, depthAt, landH, nearHump } from '@keysrun/shared/world/depth';
import { chainZ } from '@keysrun/shared/world/chain';
import { chooseFish, fightParamsFor, startFight, stepFight } from '@keysrun/shared/sim/fight';
import { TACKLE, tackleById } from '@keysrun/shared/content/tackle';
import { emptyInventory, modifiersFor } from '@keysrun/shared/sim/shop';
import { airBurnRate, AIR_MAX, SURFACE_REFILL_RATE } from '@keysrun/shared/sim/diver';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(HERE, 'playthrough', 'model.json');
const rng = xoshiro128ss(0xc0ffee); // fixed seed: the report is reproducible run to run
const r1 = (n) => +n.toFixed(1);
const r2 = (n) => +n.toFixed(2);

// ---- A. Geography: how far is each zone from the spawn, and how long does the boat take? -----
// Spawn is (-1150, chainZ + 305) in Boot Key Harbor (apps/client/src/state/constants.ts). Walk due
// seaward (+z relative to the chain) from the spawn and record where each zone first starts.
const SPAWN = { x: -1150, z: chainZ(-1150) + 305 };
const firstZone = {};
for (let dz = 0; dz < 4000; dz += 5) {
  const z = chainZ(SPAWN.x) + dz;
  const zn = zoneAt(SPAWN.x, z);
  if (!firstZone[zn]) firstZone[zn] = { dz, distFromSpawn: Math.abs(z - SPAWN.z), depth: r1(depthAt(SPAWN.x, z)) };
}
const boatSpeeds = BOATS.map((b) => {
  const topMs = b.top * 0.5144 * SPEED_SCALE;
  return {
    id: b.id, topKnots: b.top, topMs: r1(topMs), cooler: COOLER_CAP[b.id], draft: b.draft,
    // best case: instant full speed in a straight line. Real arrival is later (accel/turn); the
    // browser run measures the real ramp.
    secToReefBestCase: r1((firstZone.Reef?.distFromSpawn ?? 0) / topMs),
    secToGulfStreamBestCase: r1((firstZone.Offshore?.distFromSpawn ?? 0) / topMs),
  };
});

// ---- B. What each zone can give you ---------------------------------------------------------
// A bobber is only usable if it has open water all round it: the fish spawns 11 m off it and
// the fight's mangrove check kills any run that touches land, so a bobber on a shoreline would
// fake a 100% "cut off in the mangroves" rate that is geography, not game design.
function openWater(x, z, r = 20) {
  for (let a = 0; a < 16; a++) if (landH(x + Math.cos(a * Math.PI / 8) * r, z + Math.sin(a * Math.PI / 8) * r) > -0.3) return false;
  return landH(x, z) < -0.3;
}
const bobberCache = {};
function sampleBobber(zone) {
  if (zone in bobberCache) return bobberCache[zone];
  const f = firstZone[zone];
  let found = null;
  if (f) {
    // walk seaward from the zone's first dz, take the first spot in the zone with open water round it
    // (offshore: ~400 m inside the stream so offshoreF > 0 and the BIG-fish weighting is live)
    const start = f.dz + (zone === 'Offshore' ? 400 : zone === 'Reef' ? 100 : 0);
    for (let dz = start; dz < start + 400 && !found; dz += 5) {
      const x = SPAWN.x, z = chainZ(x) + dz;
      if (zoneAt(x, z) === zone && openWater(x, z, 20)) found = { x, z };
    }
    // Flats never have 20 m of open water round them (that is what makes them flats). Settle for
    // the deepest wet point in the zone; the mangrove losses this then shows are real, not noise.
    for (let dz = f.dz; dz < f.dz + 400 && !found && zone === 'Flats'; dz += 5) {
      const x = SPAWN.x, z = chainZ(x) + dz;
      if (zoneAt(x, z) === zone && landH(x, z) < -0.3) found = { x, z };
    }
  }
  // Last resort so a zone is never silently dropped from the report: the species table does not
  // depend on geography, only the fight's land check does. Any losses there are flagged by name.
  if (!found && f) found = { x: SPAWN.x, z: chainZ(SPAWN.x) + f.dz + 50, nominal: true };
  return (bobberCache[zone] = found);
}
const ZONES = ['Backcountry', 'Flats', 'Hawk Channel', 'Reef', 'Offshore'];
const N_ROLL = 4000;
const speciesOf = (z) => new Set((ZONE_TABLE[z] ?? []).map(([k]) => k));
const zoneStats = {};
for (const zone of ZONES) {
  const bob = sampleBobber(zone);
  if (!bob) continue;
  const counts = {};
  let pts = 0, wsum = 0;
  for (let i = 0; i < N_ROLL; i++) {
    const f = chooseFish(zone, bob, { hotspot: false, hump: nearHump(bob.x, bob.z) }, rng);
    counts[f.key] = (counts[f.key] ?? 0) + 1;
    pts += f.weight * SPECIES[f.key].mult; wsum += f.weight;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  let H = 0;
  for (const [, c] of ranked) { const p = c / N_ROLL; H -= p * Math.log2(p); }
  const others = ZONES.filter((z2) => z2 !== zone);
  zoneStats[zone] = {
    bobber: { x: Math.round(bob.x), z: Math.round(bob.z), zoneAt: zoneAt(bob.x, bob.z), depth: r1(depthAt(bob.x, bob.z)) },
    distinctSpecies: ranked.length,
    effectiveSpecies: r2(2 ** H), // perplexity: "how many species does this zone feel like it has"
    top5: ranked.slice(0, 5).map(([k, c]) => `${k} ${r1(100 * c / N_ROLL)}%`),
    avgWeightLb: r1(wsum / N_ROLL), avgPointsPerCatch: Math.round(pts / N_ROLL),
    // species you can only meet in this zone and none of the other four: what the trip unlocks
    exclusive: [...speciesOf(zone)].filter((k) => others.every((z2) => !speciesOf(z2).has(k))),
  };
}
const anyZone = new Set(ZONES.flatMap((z) => [...speciesOf(z)]));

// ---- C. The fight: who wins, why they lose, and does any drag setting dominate? -------------
// The boat sits at the bobber and the fish starts CAST_M metres away. The original harness used
// 11 m (chooseFish's spawn offset), which is NOT what a player faces: casts are 12-85 m, so a
// real fight starts 20-60 m out. CAST_M=11 reproduces the old numbers exactly; the default 35 is
// a typical cast. The boat is stationary (a real player can chase a spooling fish with the
// throttle), so spool/mangrove rates here are an UPPER bound on what a skilled player loses.
const CAST_M = +(process.env.CAST_M ?? 35);
const TACKLE_ID = process.env.TACKLE ?? 'mono30';
const TK = tackleById(TACKLE_ID);
// Shop gear, e.g. GEAR=rod.heavy,reel.lever FLUORO=1. Goes through the real modifiersFor, so this
// measures exactly what the game applies (sim/shop.ts), not a re-implementation of it.
const GEAR_KEYS = (process.env.GEAR ?? '').split(',').filter(Boolean);
const GEAR_MODS = modifiersFor({ ...emptyInventory(), gear: GEAR_KEYS }, 0);
const GEAR = { lineMul: GEAR_MODS.lineMul, reelMul: GEAR_MODS.reelMul, fluoro: !!process.env.FLUORO };
const DT = 1 / 30;
const withDrag = (d) => (typeof d === 'number' ? { drag: d } : d);

/** Player models. Each is (state, params, ctx) -> boolean reel; `react` is how often a human
 * re-decides (reaction + key travel). The first five are the ORIGINAL policies, unchanged, so the
 * before/after table is like for like; `angler`/`expert` are what a competent human does. */
const POLICIES = {
  hold: { react: 0, f: () => true },
  bangbang: { react: 0, f: (s) => s.tension < 0.78 && !s.airborne },
  sloppy: { react: 0.35, f: (s) => s.tension < 0.9 },
  slow: { react: 0.6, f: (s) => s.tension < 0.78 && !s.airborne },
  timid: { react: 0, f: (s) => s.tension < 0.4 && !s.airborne },
  // Paying attention (250 ms): feather through jumps, never crank a fresh running fish, pump a
  // resting one, back off before the bar gets near the line's current (chafed) limit.
  angler: {
    react: 0.25,
    f: (s) => {
      const lim = s.limit ?? 1;
      if (s.airborne) return s.tension < 0.12;
      if (s.tension > lim * 0.7) return false;
      if (s.running) return s.stam < 0.5 && s.tension < lim * 0.45;
      return s.tension < lim * 0.65;
    },
  },
  // Same rules at 100 ms plus it reads the fish: tightens the drag as the fish tires.
  expert: {
    react: 0.1,
    drag: (s, base) => (s.stam < 0.35 ? Math.min(5, base + 1) : s.stam > 0.8 ? Math.max(1, base - 0.5) : base),
    f: (s) => {
      const lim = s.limit ?? 1;
      if (s.airborne) return s.tension < 0.12;
      if (s.tension > lim * 0.74) return false;
      if (s.running) return s.stam < 0.5 && s.tension < lim * 0.5;
      return s.tension < lim * 0.7;
    },
  },
};

function fight(key, weight, dragSpec, bob, policyName = 'angler', tk = TK) {
  const pol = POLICIES[policyName];
  const { drag: base } = withDrag(dragSpec);
  const params = fightParamsFor(key, weight, base, tk, GEAR);
  let s = startFight(params, bob.x + CAST_M, bob.z, rng);
  const env = { boatX: bob.x, boatZ: bob.z };
  let t = 0, held = true, nextDecide = 0, drag = base, peak = 0;
  while (s.outcome === 'fighting' && t < 900) {
    if (t >= nextDecide) { held = pol.f(s, params); drag = pol.drag ? pol.drag(s, base) : base; nextDecide = t + pol.react; }
    s = stepFight(s, { reeling: held, drag }, params, env, rng, DT);
    t += DT; if (s.tension > peak) peak = s.tension;
  }
  return { outcome: s.outcome === 'fighting' ? 'timeout' : s.outcome, t, abrasion: s.abrasion };
}
const fightOnce = (key, weight, drag, bob) => fight(key, weight, drag, bob, 'angler');

const OUTCOMES = ['landed', 'snapped', 'frayed', 'pulled', 'slack', 'spooled', 'mangrove', 'timeout'];
const pct = (o, n) => Object.fromEntries(OUTCOMES.filter((k) => o[k]).map((k) => [k + 'Pct', r1(100 * o[k] / n)]));
const rollZoneMix = (n, zones = ZONES) => {
  const out = [];
  for (const zone of zones) {
    const bob = sampleBobber(zone); if (!bob || bob.nominal) continue;
    for (let i = 0; i < n; i++) out.push({ bob, zone, ...chooseFish(zone, bob, { hotspot: false, hump: null }, rng) });
  }
  return out;
};

// Same five original player models as the first harness, drag 3 (the default), zone-weighted mix.
const mix = rollZoneMix(300);
const fightByPolicy = {};
// 'contested' = fish whose fresh-run pull is >= 0.25 line ratings on this tackle (mahi and up). The
// zone mix is mostly small reef fish that no sane player loses, which flattens every skill gap; the
// contested subset is where skill is actually decided.
const contested = (f) => fightParamsFor(f.key, f.weight, 3, TK).pullN >= 0.25;
const nContested = mix.filter(contested).length;
for (const policy of ['bangbang', 'sloppy', 'slow', 'timid', 'hold', 'angler', 'expert']) {
  const o = {}, oc = {};
  for (const f of mix) {
    const r = fight(f.key, f.weight, 3, f.bob, policy); o[r.outcome] = (o[r.outcome] ?? 0) + 1;
    if (contested(f)) oc[r.outcome] = (oc[r.outcome] ?? 0) + 1;
  }
  fightByPolicy[policy] = { n: mix.length, ...Object.fromEntries(Object.entries(pct(o, mix.length)).sort()), contested: { n: nContested, ...Object.fromEntries(Object.entries(pct(oc, nContested)).sort()) } };
}
// By zone and tackle for the attentive player at drag 3: what does the starter outfit get you where,
// and what does each rung of the ladder buy? (the economy seam: this is what a tackle upgrade is worth)
const fightByZoneTackle = {};
for (const tk of TACKLE) {
  fightByZoneTackle[tk.id] = {};
  for (const zone of ZONES) {
    const fs_ = mix.filter((f) => f.zone === zone); if (!fs_.length) continue;
    let win = 0, secs = 0;
    for (const f of fs_) { const r = fight(f.key, f.weight, 3, f.bob, 'angler', tk); if (r.outcome === 'landed') { win++; secs += r.t; } }
    fightByZoneTackle[tk.id][zone] = `${r1(100 * win / fs_.length)}% in ${r1(secs / Math.max(1, win))}s`;
  }
}
// The mix is dominated by small reef fish, which is what a player mostly catches. The trophy
// view re-rolls with a size bias so "a big one on light tackle" is measured, not assumed.
const fightByDrag = {};
for (const drag of [1, 2, 3, 4, 5]) {
  const o = {}; let tLand = 0, n = 0;
  for (const f of mix) {
    const r = fight(f.key, f.weight, drag, f.bob); o[r.outcome] = (o[r.outcome] ?? 0) + 1; n++;
    if (r.outcome === 'landed') tLand += r.t;
  }
  fightByDrag[drag] = { n, winPct: r1(100 * (o.landed ?? 0) / n), ...pct(o, n), avgFightSecWhenLanded: r1(tLand / Math.max(1, o.landed ?? 0)) };
}

// Per-species, per-drag, one attentive player: zone-agnostic size roll, fought in the reef's open
// water. This is the dominance check. `tied` = every drag whose win rate is within 1.5 standard
// errors of the best, i.e. indistinguishable from it at this sample size: an honest argmax must
// not be decided by tie-breaking, which is how the original harness reported drag 1 "best" 49/49.
const SP_N = +(process.env.SP_N ?? 200);
const speciesDrag = {};
const strictBest = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
const tiedBest = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
const fightBySpecies = {};
const bobReef = sampleBobber('Offshore') ?? sampleBobber('Reef');
for (const key of Object.keys(SPECIES)) {
  const S = SPECIES[key];
  const weights = Array.from({ length: SP_N }, () => S.min + (S.max - S.min) * Math.pow(rng(), 1.8));
  const row = {}; let bestW = -1, bestD = 0;
  for (const d of [1, 2, 3, 4, 5]) {
    let win = 0, tw = 0; const lose = {};
    for (const w of weights) {
      const r = fight(key, w, d, bobReef);
      if (r.outcome === 'landed') { win++; tw += r.t; } else lose[r.outcome] = (lose[r.outcome] ?? 0) + 1;
    }
    row[d] = { winPct: r1(100 * win / SP_N), sec: r1(tw / Math.max(1, win)), lose };
    if (win > bestW) { bestW = win; bestD = d; }
  }
  const se = (p) => Math.sqrt(Math.max(p * (1 - p), 0.0025) / SP_N);
  const bp = bestW / SP_N;
  const tied = [1, 2, 3, 4, 5].filter((d) => row[d].winPct / 100 >= bp - 1.5 * se(bp)).map(Number);
  // Tie-break by the shorter fight, never by index: ties are the common case for small fish and the
  // original harness's first-wins rule is what made drag 1 'best' for 49/49.
  bestD = tied.reduce((a, d) => (row[d].sec > 0 && row[d].sec < (row[a].sec || Infinity) ? d : a), tied[0]);
  const spread = Math.max(...[1, 2, 3, 4, 5].map((d) => row[d].winPct)) - Math.min(...[1, 2, 3, 4, 5].map((d) => row[d].winPct));
  const decisive = spread >= 10;
  speciesDrag[key] = { bestDrag: bestD, tied, decisive, spread: r1(spread), winByDrag: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, row[d].winPct])), secByDrag: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, row[d].sec])), loseByDrag: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, row[d].lose])) };
  if (decisive) strictBest[bestD]++; for (const d of tied) tiedBest[d]++;
  fightBySpecies[key] = { winPct3: row[3].winPct, avgSec3: row[3].sec, losses3: row[3].lose, str: S.str, maxLb: S.max, mult: S.mult };
}
// A drag "dominates" if it is in the tied-best set for every species AND strictly shortens fights
// without costing wins. Report the plain facts: per drag, in how many species it is (tied-)best,
// and the mean win rate across species.
const decisiveCount = Object.values(speciesDrag).filter((v) => v.decisive).length;
const dragSummary = {};
for (const d of [1, 2, 3, 4, 5]) {
  const ws = Object.values(speciesDrag).map((r) => r.winByDrag[d]);
  const ss = Object.values(speciesDrag).map((r) => r.secByDrag[d]).filter((x) => x > 0);
  dragSummary[d] = { strictBestSpecies: strictBest[d], tiedBestSpecies: tiedBest[d], meanWinPct: r1(ws.reduce((a, b) => a + b, 0) / ws.length), meanFightSec: r1(ss.reduce((a, b) => a + b, 0) / ss.length), worstSpeciesWinPct: Math.min(...ws), decisiveSpecies: decisiveCount };
}
const bestDragPerSpecies = Object.fromEntries(Object.entries(speciesDrag).map(([k, v]) => [k, v.bestDrag]));
const dragHistogram = { ...strictBest }; // decisive species only (win-rate spread across drags >= 10 points)

// Trophy view: top-decile size of each big-game species on light vs heavy tackle, attentive player.
const tackleView = {};
{
  const BIG = ['tarpon', 'amberjack', 'yellowfin', 'wahoo', 'sailfish', 'marlin', 'bluefin', 'goliath', 'hammerhead', 'cobia', 'snook', 'mahi', 'permit'];
  for (const tk of TACKLE) {
    const row = {};
    for (const key of BIG) {
      const S = SPECIES[key]; let ord = 0, tro = 0; const N = 80;
      for (let i = 0; i < N; i++) {
        if (fight(key, S.min + (S.max - S.min) * (0.15 + 0.35 * rng()), 3, bobReef, 'angler', tk).outcome === 'landed') ord++;
        if (fight(key, S.min + (S.max - S.min) * (0.85 + 0.15 * rng()), 3, bobReef, 'angler', tk).outcome === 'landed') tro++;
      }
      row[key] = `${Math.round(100 * ord / N)}/${Math.round(100 * tro / N)}`;
    }
    tackleView[tk.id] = row;
  }
}
if (process.env.FIGHT_ONLY) {
  console.log(JSON.stringify({ CAST_M, TACKLE_ID, GEAR_KEYS, GEAR, fightByPolicy, fightByDrag, fightByZoneTackle, dragSummary, dragHistogram, speciesDrag, tackleView }, null, 1));
  process.exit(0);
}
// ---- D. Session simulation: what does N minutes of play look like, and is anything new? ----
// Cast cycle in SIMULATED seconds, from game/fishing/update.ts: cast flight 0.5+0.9*power, bite
// timer rand(4,10), nibbles 1-3 x ~1.2 s, a 1.4 s strike window, the fight, then the catch card
// (~4 s of reading) and ~1 s human reaction on the strike.
function sessionSim(zone, minutes, drag = 3) {
  const bob = sampleBobber(zone); const budget = minutes * 60;
  let t = 0, catches = 0, casts = 0, score = 0; const seen = new Set(); const log = [];
  let bestPts = 0; const gaps = [];
  let lastNovel = 0, firstCatch = null;
  while (t < budget) {
    casts++;
    t += 0.5 + 0.9 * 0.5 + 4 + rng() * 6 + (1 + Math.floor(rng() * 3)) * 1.2 + 1.0;
    const f = chooseFish(zone, bob, { hotspot: false, hump: null }, rng);
    const r = fightOnce(f.key, f.weight, drag, bob);
    t += r.t;
    if (r.outcome !== 'landed') { t += 2; continue; } // loss toast + rod stow
    t += 4;
    catches++; if (firstCatch === null) firstCatch = t;
    const pts = Math.round(f.weight * SPECIES[f.key].mult);
    score += Math.round(pts * 1.25); // released: +25% conservation bonus
    let novel = null;
    if (!seen.has(f.key)) { seen.add(f.key); novel = 'new species ' + f.key; }
    if (pts > bestPts) { bestPts = pts; novel = novel ?? 'new personal best'; }
    if (novel && t < budget) { gaps.push(t - lastNovel); lastNovel = t; log.push([Math.round(t), novel]); }
  }
  gaps.push(budget - lastNovel);
  gaps.sort((a, b) => a - b);
  return { catches, score, speciesSeen: seen.size, noveltyEvents: log.length, longestGapSec: Math.round(gaps[gaps.length - 1]), medianGapSec: Math.round(gaps[gaps.length >> 1]), lastNoveltyAtSec: log.length ? log[log.length - 1][0] : 0, firstCatchSec: firstCatch ?? budget, casts };
}
const sessions = {};
for (const zone of ZONES) {
  if (!sampleBobber(zone) || sampleBobber(zone).nominal) continue;
  // 40 sessions per zone, averaged, so one lucky roll can't masquerade as a trend
  const runs = Array.from({ length: 40 }, () => sessionSim(zone, 30));
  const avg = (k) => r1(runs.reduce((a, r) => a + r[k], 0) / runs.length);
  sessions[zone] = {
    simMinutes: 30, casts: avg('casts'), catches: avg('catches'), catchesPerMin: r2(avg('catches') / 30), firstCatchSec: avg('firstCatchSec'),
    score: avg('score'), speciesSeen: avg('speciesSeen'), speciesInZoneTable: speciesOf(zone).size,
    noveltyEvents: avg('noveltyEvents'), lastNoveltyAtSec: avg('lastNoveltyAtSec'), longestGapSec: avg('longestGapSec'), medianGapSec: avg('medianGapSec'),
  };
}
// Species-discovery curve: how many CATCHES until you have seen 50/80/95% of what a zone can
// give? This is the "reason to keep playing" clock for a collector.
const discovery = {};
for (const zone of ZONES) {
  const bob = sampleBobber(zone); if (!bob || bob.nominal) continue; // nominal = no real open water (flats): odds only, no fights
  const total = speciesOf(zone).size;
  const marks = { 50: [], 80: [], 95: [] };
  for (let run = 0; run < 60; run++) {
    const seen = new Set(); let n = 0; const hit = {};
    while (n < 5000 && Object.keys(hit).length < 3) {
      n++; seen.add(chooseFish(zone, bob, { hotspot: false, hump: null }, rng).key);
      for (const p of [50, 80, 95]) if (!hit[p] && seen.size >= Math.ceil(total * p / 100)) hit[p] = n;
    }
    for (const p of [50, 80, 95]) marks[p].push(hit[p] ?? 5000);
  }
  const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
  discovery[zone] = { speciesInTable: total, medianCatchesTo50pct: med(marks[50]), to80pct: med(marks[80]), to95pct: med(marks[95]) };
}

// ---- E. Economy: what is a catch worth, and is there anything to spend it on? ---------------
const pts = [];
for (const zone of ZONES) {
  const bob = sampleBobber(zone); if (!bob || bob.nominal) continue; // nominal = no real open water (flats): odds only, no fights
  for (let i = 0; i < 1500; i++) { const f = chooseFish(zone, bob, { hotspot: false, hump: null }, rng); pts.push(Math.round(f.weight * SPECIES[f.key].mult)); }
}
pts.sort((a, b) => a - b);
const economy = {
  releaseBonusPct: 25, weighInPointsPerLb: 6,
  pointsPerCatchP50: pts[pts.length >> 1], pointsPerCatchP90: pts[Math.floor(pts.length * 0.9)], pointsPerCatchMax: pts[pts.length - 1],
  speciesWithMeatPrice: Object.keys(MEAT_PRICE).length, speciesNoSale: Object.keys(NO_SALE).length,
  coolerCaps: COOLER_CAP,
};

// ---- F. Diving: how long can you stay down? -----------------------------------------------
// airBurnRate(depth, exertion) against AIR_MAX = 90 budget units; surface refill is AIR_MAX/3 per s.
const dive = {};
for (const [label, ex] of [['drifting_0', 0], ['hunting_0.45', 0.45], ['sprinting_1', 1]]) {
  dive[label] = Object.fromEntries([2, 5, 10, 20, 30].map((d) => [d + 'm', r1(AIR_MAX / airBurnRate(d, ex))]));
}
dive.surfaceRefillSec = r1(AIR_MAX / SURFACE_REFILL_RATE);
dive.unit = 'seconds of air from full at constant depth/exertion';

const report = {
  note: 'simulated seconds, never wall clock', spawn: SPAWN, firstZone, boatSpeeds, zoneStats,
  speciesReachableByRod: anyZone.size, totalSpecies: Object.keys(SPECIES).length,
  castM: CAST_M, tackle: TACKLE_ID, fightByZoneTackle, fightByDrag, fightByPolicy, fightBySpecies, dragSummary, speciesDrag, tackleView,
  bestDragHistogram: dragHistogram, bestDragPerSpecies, sessions, discovery, economy, dive,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ firstZone, boatSpeeds, zoneStats, speciesReachableByRod: anyZone.size, castM: CAST_M, fightByDrag, fightByPolicy, dragSummary, bestDragHistogram: dragHistogram, tackleView, sessions, discovery, economy, dive }, null, 1));
console.log('wrote', OUT);
