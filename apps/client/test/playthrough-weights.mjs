/**
 * Landed-weight distribution per zone: does the rod produce big fish, and are they free?
 *
 * Companion to playthrough-model.mjs (same shared sim, headless, fixed seed, simulated seconds).
 * It answers the "bigger fish on the rod" question with two numbers per zone and tackle: what the
 * roll HOOKS (species x weight), and what an attentive player actually LANDS. Reporting only the
 * first would just inflate weights (the old sim landed ~everything it hooked, so hooked == landed);
 * reporting only the second would hide whether big fish exist at all.
 *
 * Usage:
 *   node apps/client/test/playthrough-weights.mjs [outFile]
 *   node apps/client/test/playthrough-weights.mjs out.json --shared=/abs/path/to/old/packages/shared/dist
 * The second form runs the SAME script against another build of @keysrun/shared (e.g. HEAD~ built
 * into a scratch dir), which is how the before/after table was produced. Tackle data is always
 * read from the current package (the old build has none; its fightParamsFor ignores the argument).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const sharedArg = args.find((a) => a.startsWith('--shared='))?.slice(9);
const OUT = args.find((a) => !a.startsWith('--')) || null;
const N = +(process.env.N ?? 2500);
const imp = (name) => import(sharedArg
  ? pathToFileURL(`${sharedArg}/${name === 'rng' ? 'rng/index' : name}.js`).href
  : `@keysrun/shared/${name}`);
const { xoshiro128ss } = await imp('rng');
const { SPECIES } = await imp('content/species');
const { landH, zoneAt } = await imp('world/depth');
const { chainZ } = await imp('world/chain');
const { chooseFish, fightParamsFor, startFight, stepFight } = await imp('sim/fight');
const { tackleById, STARTER_TACKLE } = await import('@keysrun/shared/content/tackle');

const rng = xoshiro128ss(0xb16f15);
const SPAWN = { x: -1150, z: chainZ(-1150) + 305 };
const r1 = (n) => +n.toFixed(1);

function openWater(x, z, r = 20) {
  for (let a = 0; a < 16; a++) if (landH(x + Math.cos(a * Math.PI / 8) * r, z + Math.sin(a * Math.PI / 8) * r) > -0.3) return false;
  return landH(x, z) < -0.3;
}
function bobberIn(zone) {
  let first = null;
  for (let dz = 0; dz < 4000 && first === null; dz += 5) if (zoneAt(SPAWN.x, chainZ(SPAWN.x) + dz) === zone) first = dz;
  if (first === null) return null;
  const start = first + (zone === 'Offshore' ? 400 : zone === 'Reef' ? 100 : 0);
  for (let dz = start; dz < start + 400; dz += 5) {
    const z = chainZ(SPAWN.x) + dz;
    if (zoneAt(SPAWN.x, z) === zone && openWater(SPAWN.x, z, 20)) return { x: SPAWN.x, z };
  }
  return null;
}
// Weedline/Oil Rig are not geographic zones (they come from hotspots); in play they sit in open
// water, so fish them from the Gulf Stream bobber with the hotspot flag on.
const OFFSHORE = bobberIn('Offshore');
const SITES = [
  { name: 'Hawk Channel', table: 'Hawk Channel', bob: bobberIn('Hawk Channel'), hotspot: false },
  { name: 'Reef', table: 'Reef', bob: bobberIn('Reef'), hotspot: false },
  { name: 'Offshore (Gulf Stream)', table: 'Offshore', bob: OFFSHORE, hotspot: false },
  { name: 'Weedline (hotspot)', table: 'Weedline', bob: OFFSHORE, hotspot: true },
  { name: 'Oil Rig (hotspot)', table: 'Oil Rig', bob: OFFSHORE, hotspot: true },
  // A wreck is cast on from the reef side of the chart (all six sit on the wall or inshore of it), so
  // it is compared against a plain reef cast AND a reef cast with the hotspot flag on: the second
  // is the fair control, since a wreck cast always sets F.hs. Weight on a wreck ignores the bobber
  // (wreckSizeT), so the bobber only decides which fights are run, not the roll.
  { name: 'Reef (hotspot control)', table: 'Reef', bob: bobberIn('Reef'), hotspot: true },
  { name: 'Wreck (hotspot)', table: 'Wreck', bob: bobberIn('Reef'), hotspot: true },
];

/** Attentive angler, same rules as playthrough-model.mjs's `angler`. */
const angler = (s) => {
  const lim = s.limit ?? 1;
  if (s.airborne) return s.tension < 0.12;
  if (s.tension > lim * 0.7) return false;
  if (s.running) return s.stam < 0.5 && s.tension < lim * 0.45;
  return s.tension < lim * 0.65;
};
function fight(key, weight, drag, bob, tk) {
  const params = fightParamsFor(key, weight, drag, tk);
  let s = startFight(params, bob.x + 35, bob.z, rng);
  const env = { boatX: bob.x, boatZ: bob.z };
  let t = 0, held = true, next = 0;
  while (s.outcome === 'fighting' && t < 900) {
    if (t >= next) { held = angler(s); next = t + 0.25; }
    s = stepFight(s, { reeling: held, drag }, params, env, rng, 1 / 30);
    t += 1 / 30;
  }
  return s.outcome === 'fighting' ? 'timeout' : s.outcome;
}
const sizeT = (key, w) => (w - SPECIES[key].min) / (SPECIES[key].max - SPECIES[key].min);
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const stats = (ws) => {
  const a = [...ws].sort((x, y) => x - y);
  return { n: a.length, mean: r1(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)), p50: r1(q(a, 0.5)), p90: r1(q(a, 0.9)), p99: r1(q(a, 0.99)), max: r1(a[a.length - 1] ?? 0) };
};

const report = { n: N, shared: sharedArg ?? 'package', zones: {} };
for (const site of SITES) {
  if (!site.bob) continue;
  const rolls = Array.from({ length: N }, () => chooseFish(site.table, site.bob, { hotspot: site.hotspot, hump: null }, rng));
  const zoneOut = { hooked: stats(rolls.map((f) => f.weight)) };
  const trophyHooked = rolls.filter((f) => sizeT(f.key, f.weight) >= 0.85);
  const huge = rolls.filter((f) => f.weight >= 100);
  zoneOut.hookedTrophyPct = r1(100 * trophyHooked.length / N);
  zoneOut.hookedOver100lbPct = r1(100 * huge.length / N);
  zoneOut.hookedTop = Object.entries(rolls.reduce((m, f) => (m[f.key] = (m[f.key] ?? 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${k} ${r1(100 * c / N)}%`);
  // Whatever the player actually starts on, plus a high rung for contrast. Reading the
  // starter from the content table rather than hardcoding it means moving the starting rung
  // shows up here instead of silently reporting the old one.
  for (const tkId of [STARTER_TACKLE, 'braid80']) {
    const tk = tackleById(tkId);
    const landed = [], lostTrophy = {}; let landedTrophy = 0, landedHuge = 0, win = 0;
    for (const f of rolls) {
      const o = fight(f.key, f.weight, 3, site.bob, tk);
      const trophy = sizeT(f.key, f.weight) >= 0.85;
      if (o === 'landed') { win++; landed.push(f.weight); if (trophy) landedTrophy++; if (f.weight >= 100) landedHuge++; }
      else if (trophy) lostTrophy[o] = (lostTrophy[o] ?? 0) + 1;
    }
    zoneOut[tkId] = {
      winPct: r1(100 * win / N), landed: stats(landed),
      landedTrophyPct: r1(100 * landedTrophy / N), landedOver100lbPct: r1(100 * landedHuge / N),
      trophyConversionPct: r1(100 * landedTrophy / Math.max(1, trophyHooked.length)),
      over100ConversionPct: r1(100 * landedHuge / Math.max(1, huge.length)),
      trophiesLostBy: lostTrophy,
    };
  }
  report.zones[site.name] = zoneOut;
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
