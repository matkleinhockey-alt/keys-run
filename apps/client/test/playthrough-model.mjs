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

// ---- C. The fight: win rate and cause of loss, by drag setting (the ONLY "gear" knob) -------
// Bot policy = the same bang-bang the existing capture-fishing.mjs uses (reel while tension is
// safe, ease off once hot), plus the "bow to the fish" rule the game tells the player itself:
// don't reel while airborne. The boat is stationary (a real player can chase a spooling fish with
// the throttle), so spool/mangrove rates here are an UPPER bound on what a skilled player loses.
function fightOnce(key, weight, drag, bob = { x: 0, z: 0 }, thr = 0.78, easeInAir = true) {
  const params = fightParamsFor(key, weight, drag);
  // chooseFish puts the fish ~11 m off the bobber; the boat sits at the bobber's position so
  // depth/land checks (mangrove outcome) see real water, not the world origin.
  let s = startFight(params, bob.x + 11, bob.z, rng);
  const env = { boatX: bob.x, boatZ: bob.z };
  const dt = 1 / 30;
  let t = 0;
  while (s.outcome === 'fighting' && t < 600) {
    const reeling = s.tension < thr && !(easeInAir && s.airborne);
    s = stepFight(s, { reeling }, params, env, rng, dt);
    t += dt;
  }
  return { outcome: s.outcome === 'fighting' ? 'timeout' : s.outcome, t };
}
// How much does skill matter? Same fights, five player models. `sloppy`/`slow` re-decide only
// every N seconds (reaction time + key travel), which is the realistic failure mode for a human.
function fightPolicy(key, weight, drag, bob, policy) {
  const params = fightParamsFor(key, weight, drag);
  let s = startFight(params, bob.x + 11, bob.z, rng);
  const env = { boatX: bob.x, boatZ: bob.z };
  const dt = 1 / 30; let t = 0, held = true, nextDecide = 0;
  while (s.outcome === 'fighting' && t < 600) {
    if (t >= nextDecide) {
      if (policy === 'hold') held = true;
      else if (policy === 'bangbang') held = s.tension < 0.78 && !s.airborne;
      else if (policy === 'sloppy') { held = s.tension < 0.9; nextDecide = t + 0.35; } // 350 ms reaction, ignores the jump advice
      else if (policy === 'slow') { held = s.tension < 0.78 && !s.airborne; nextDecide = t + 0.6; } // 600 ms reaction
      else if (policy === 'timid') held = s.tension < 0.4 && !s.airborne; // never trusts the line
    }
    s = stepFight(s, { reeling: held }, params, env, rng, dt); t += dt;
  }
  return s.outcome === 'fighting' ? 'timeout' : s.outcome;
}
const fightByPolicy = {};
for (const policy of ['bangbang', 'sloppy', 'slow', 'timid', 'hold']) {
  const o = {}; let n = 0;
  for (const zone of ZONES) {
    const bob = sampleBobber(zone); if (!bob || bob.nominal) continue; // nominal = no real open water (flats): odds only, no fights
    for (let i = 0; i < 300; i++) {
      const f = chooseFish(zone, bob, { hotspot: false, hump: null }, rng);
      const r = fightPolicy(f.key, f.weight, 3, bob, policy);
      o[r] = (o[r] ?? 0) + 1; n++;
    }
  }
  fightByPolicy[policy] = Object.fromEntries(Object.entries(o).map(([k, v]) => [k + 'Pct', r1(100 * v / n)]));
}
const fightByDrag = {};
for (const drag of [1, 2, 3, 4, 5]) {
  const o = { landed: 0, snapped: 0, slack: 0, spooled: 0, mangrove: 0, timeout: 0 };
  let tLand = 0, n = 0;
  for (const zone of ZONES) {
    const bob = sampleBobber(zone);
    if (!bob || bob.nominal) continue; // nominal = no real open water (flats): odds only, no fights
    for (let i = 0; i < 400; i++) {
      const f = chooseFish(zone, bob, { hotspot: false, hump: null }, rng);
      const r = fightOnce(f.key, f.weight, drag, bob);
      o[r.outcome]++; n++;
      if (r.outcome === 'landed') tLand += r.t;
    }
  }
  fightByDrag[drag] = { n, winPct: r1(100 * o.landed / n), ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'landed').map(([k, v]) => [k + 'Pct', r1(100 * v / n)])), avgFightSecWhenLanded: r1(tLand / Math.max(1, o.landed)) };
}
// Win rate by species at the default drag (3): which fish are a wall, as data. Fought over the
// reef's open water so geography (mangrove/land) doesn't contaminate a species comparison.
const fightBySpecies = {};
for (const key of Object.keys(SPECIES)) {
  const S = SPECIES[key];
  let win = 0, t = 0; const lose = {};
  const N = 120;
  for (let i = 0; i < N; i++) {
    const w = S.min + (S.max - S.min) * Math.pow(rng(), 1.8); // zone-agnostic size roll
    const r = fightOnce(key, w, 3, sampleBobber('Reef'));
    if (r.outcome === 'landed') { win++; t += r.t; } else lose[r.outcome] = (lose[r.outcome] ?? 0) + 1;
  }
  fightBySpecies[key] = { winPct: Math.round(100 * win / N), avgSec: r1(t / Math.max(1, win)), losses: lose, str: S.str, maxLb: S.max, mult: S.mult };
}
// Does a different drag change the answer per species? If one setting wins everything the knob
// is a solved puzzle rather than a progression axis.
const bestDragPerSpecies = {};
for (const key of Object.keys(SPECIES)) {
  const S = SPECIES[key]; let best = -1, bestD = 3;
  for (const d of [1, 2, 3, 4, 5]) {
    let win = 0;
    for (let i = 0; i < 60; i++) {
      const w = S.min + (S.max - S.min) * (0.5 + 0.5 * rng());
      if (fightOnce(key, w, d, sampleBobber('Reef')).outcome === 'landed') win++;
    }
    if (win > best) { best = win; bestD = d; }
  }
  bestDragPerSpecies[key] = bestD;
}
const dragHistogram = {};
for (const d of Object.values(bestDragPerSpecies)) dragHistogram[d] = (dragHistogram[d] ?? 0) + 1;

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
  fightByDrag, fightByPolicy, fightBySpecies, bestDragHistogram: dragHistogram, bestDragPerSpecies, sessions, discovery, economy, dive,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ firstZone, boatSpeeds, zoneStats, speciesReachableByRod: anyZone.size, fightByDrag, fightByPolicy, bestDragHistogram: dragHistogram, sessions, discovery, economy, dive }, null, 1));
console.log('wrote', OUT);
