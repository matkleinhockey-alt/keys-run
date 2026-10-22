/**
 * Dollars per simulated session, per zone, per gear loadout. Companion to playthrough-model.mjs
 * (same shared sim, same cast cycle, same 'angler' player model, fixed seed, SIMULATED seconds) but
 * it reports MONEY (sim/economy.ts fishValue summed over landed fish) instead of score, which is
 * what BOAT_PRICE / TACKLE_PRICE / the town's shelf prices are balanced against.
 *
 * Gear is modelled the way sim/shop.ts's `modifiersFor` describes it: lineMul scales the tackle's
 * line AND leader rating (the fight sim reads min(line, leader)), reelMul scales reelMs, biteMul
 * scales the bite wait. Nothing here edits shared; it measures.
 *
 * Usage: node apps/client/test/playthrough-economy.mjs
 *   SESSIONS=60 MIN=30 node ...      (defaults)
 *   SWEEP="name:tackle:lineMul:reelMul,..." node ...   named loadouts side by side
 *   TACKLE=braid80 LINE=1.35 REEL=0.95 BITE=1 node ...   one custom loadout across zones
 */
import { xoshiro128ss } from '@keysrun/shared/rng';
import { zoneAt, landH } from '@keysrun/shared/world/depth';
import { chainZ } from '@keysrun/shared/world/chain';
import { chooseFish, fightParamsFor, startFight, stepFight } from '@keysrun/shared/sim/fight';
import { TACKLE, tackleById } from '@keysrun/shared/content/tackle';
import { fishValue } from '@keysrun/shared/sim/economy';

const SESSIONS = +(process.env.SESSIONS ?? 60);
const MIN = +(process.env.MIN ?? 30);
const CAST_M = 35, DT = 1 / 30;
const SPAWN = { x: -1150, z: chainZ(-1150) + 305 };
const r0 = (n) => Math.round(n);

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
export const ZONES = ['Hawk Channel', 'Reef', 'Offshore'];
const BOB = Object.fromEntries(ZONES.map((z) => [z, bobberIn(z)]));

/** The 'angler' policy from playthrough-model.mjs (250 ms reactions, feathers through jumps). */
const angler = (s) => {
  const lim = s.limit ?? 1;
  if (s.airborne) return s.tension < 0.12;
  if (s.tension > lim * 0.7) return false;
  if (s.running) return s.stam < 0.5 && s.tension < lim * 0.45;
  return s.tension < lim * 0.65;
};

/** Tackle as the fight sees it after the shop's modifiers. */
export function loadout(tackleId, { lineMul = 1, reelMul = 1 } = {}) {
  const t = tackleById(tackleId);
  return { ...t, lineLb: t.lineLb * lineMul, leaderLb: t.leaderLb * lineMul, reelMs: t.reelMs * reelMul };
}

export function fightOnce(rng, f, bob, tk, drag = 3) {
  const params = fightParamsFor(f.key, f.weight, drag, tk);
  let s = startFight(params, bob.x + CAST_M, bob.z, rng);
  const env = { boatX: bob.x, boatZ: bob.z };
  let t = 0, held = true, next = 0;
  while (s.outcome === 'fighting' && t < 900) {
    if (t >= next) { held = angler(s); next = t + 0.25; }
    s = stepFight(s, { reeling: held, drag }, params, env, rng, DT);
    t += DT;
  }
  return { landed: s.outcome === 'landed', t };
}

/** One session; same cast cycle as playthrough-model.mjs sessionSim (biteMul scales the 4-10 s wait). */
export function session(rng, zone, minutes, tk, biteMul = 1) {
  const bob = BOB[zone]; const budget = minutes * 60;
  let t = 0, fish = 0, cash = 0, hooks = 0;
  while (t < budget) {
    t += 0.5 + 0.45 + (4 + rng() * 6) * biteMul + (1 + Math.floor(rng() * 3)) * 1.2 + 1.0;
    const f = chooseFish(zone, bob, { hotspot: false, hump: null }, rng);
    hooks++;
    const r = fightOnce(rng, f, bob, tk);
    t += r.t;
    if (!r.landed) { t += 2; continue; }
    t += 4; fish++; cash += fishValue(f.key, f.weight);
  }
  return { fish, cash, hooks };
}

export function measure(label, tk, { biteMul = 1, zones = ZONES, seed = 0xec0, sessions = SESSIONS, minutes = MIN } = {}) {
  const rng = xoshiro128ss(seed);
  const out = { label };
  for (const zone of zones) {
    const runs = Array.from({ length: sessions }, () => session(rng, zone, minutes, tk, biteMul));
    const cash = runs.map((r) => r.cash).sort((a, b) => a - b);
    out[zone] = {
      fish: r0(runs.reduce((a, r) => a + r.fish, 0) / runs.length),
      hooked: r0(runs.reduce((a, r) => a + r.hooks, 0) / runs.length),
      meanCash: r0(cash.reduce((a, b) => a + b, 0) / cash.length),
      p10: cash[Math.floor(cash.length * 0.1)], p50: cash[cash.length >> 1], p90: cash[Math.floor(cash.length * 0.9)],
    };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  if (process.env.SWEEP) {
    // SWEEP="name:tackle:lineMul:reelMul,..." e.g. "heavy:braid50:1.35:0.95,lever:braid50:1.05:1.3"
    for (const spec of process.env.SWEEP.split(',')) {
      const [name, tk, line, reel] = spec.split(':');
      rows.push(measure(`${name} (${tk} line x${line} reel x${reel})`, loadout(tk, { lineMul: +line, reelMul: +reel })));
    }
  } else if (process.env.TACKLE) {
    rows.push(measure(`${process.env.TACKLE} line x${process.env.LINE ?? 1} reel x${process.env.REEL ?? 1}`,
      loadout(process.env.TACKLE, { lineMul: +(process.env.LINE ?? 1), reelMul: +(process.env.REEL ?? 1) }), { biteMul: +(process.env.BITE ?? 1) }));
  } else {
    for (const tk of TACKLE) rows.push(measure(`${tk.id} (stock)`, loadout(tk.id)));
  }
  for (const r of rows) {
    console.log(r.label);
    for (const z of ZONES) console.log(`  ${z.padEnd(13)} fish ${String(r[z].fish).padStart(3)}/${String(r[z].hooked).padStart(3)} hooked   $${r[z].meanCash}/${MIN}min   (p10 ${r[z].p10}  p50 ${r[z].p50}  p90 ${r[z].p90})`);
  }
}
