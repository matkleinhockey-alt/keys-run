/**
 * Ocean census: a READ-ONLY measurement harness answering "what is actually in this ocean, and
 * where?" with numbers. It changes no game code; it calls the same pure placement functions the
 * game calls (spawn.ts) over a sweep of the sailable world box and tabulates the result, so any
 * later tuning change to fish population can be judged by diffing this output.
 *
 *   cd apps/client && npx vitest run test/ocean-census.test.ts
 *
 * SWEEP (all anchored at WORLD_SEED, deterministic):
 *   - resident layer  : every 64 m chunk  (residentsForChunk)
 *   - roamer layer    : every 48 m cell   (tryRoamCell) - STARTING positions only; roamers wander
 *   - near-field layer: every 18 m cell   (nearFieldForCell) - in-game only active within 72 m of
 *                       the player, so it is reported as its own layer and excluded from "macro"
 *   - wreck layer     : every wreck's hold points
 *   - the legend      : the gold bluefin school
 * "macro" = resident + roamer + wreck + legend: the population a boat sees from the surface.
 * Area/density/dead-water use a 50 m grid of navigable water points; transects step every 25 m.
 *
 * `habitatKey` below mirrors spawn.ts's private `lifeTableFor` (Humps radius 260 m, ReefWall at
 * 12 m, DeepWall at 20 m). If spawn.ts changes those constants this label drifts, but nothing
 * asserted depends on it.
 */
import { describe, expect, it } from 'vitest';
import { VIS, ZONE_LIFE } from '@keysrun/shared/content/creatures';
import { depthAt, landH, zoneAt, WB, HUMPS, type Zone } from '@keysrun/shared/world/depth';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { WRECK_RESIDENTS, wrecksFor } from '@keysrun/shared/world/wrecks';
import {
  CHUNK_SIZE, NEAR_CELL, ROAM_CELL, instantiateLegend, nearFieldForCell, residentsForChunk,
  tryRoamCell, wreckSchoolsFor,
} from '../src/entities/fish/spawn.js';
import { WORLD_SEED } from '../src/state/constants.js';

type Layer = 'resident' | 'roamer' | 'near' | 'wreck' | 'legend';
interface Rec {
  layer: Layer; type: string; x: number; z: number; n: number; depth: number; zone: Zone; region: string; hab: string;
}

/** Measured baseline of schools anchored on made ground; see test 1d. Lower to 0 when fixed. */
const KNOWN_DRY_LAND = 49;
const LAYERS: Layer[] = ['resident', 'roamer', 'near', 'wreck', 'legend'];
const isMacro = (r: Rec): boolean => r.layer !== 'near';

function habitatKey(x: number, z: number, zone: Zone, d: number): string {
  const dz = z - chainZ(x);
  for (const H of HUMPS) if (!H.patch && Math.hypot(x - H.x, dz - H.dz) < 260) return 'Humps';
  if (zone === 'Reef') return d >= 20 ? 'DeepWall' : d >= 12 ? 'ReefWall' : 'Reef';
  return zone;
}
function regionOf(x: number, z: number, zone: Zone): string {
  const dz = z - chainZ(x);
  if (zone === 'Offshore') return 'Blue water';
  if (zone === 'Reef') return 'Reef';
  if (zone === 'Bridge') return 'Bridge channel';
  if (zone === 'Hawk Channel' || (zone === 'Flats' && dz >= 0)) return 'Hawk Channel';
  return 'Bay side'; // Creek, Backcountry, bayside Flats
}
const REGIONS = ['Bay side', 'Bridge channel', 'Hawk Channel', 'Reef', 'Blue water'];
const ZONES: Zone[] = ['Creek', 'Flats', 'Backcountry', 'Bridge', 'Hawk Channel', 'Reef', 'Offshore'];

function rec(layer: Layer, type: string, x: number, z: number, n: number): Rec {
  const depth = depthAt(x, z), zone = zoneAt(x, z);
  return { layer, type, x, z, n, depth, zone, region: regionOf(x, z, zone), hab: habitatKey(x, z, zone, depth) };
}

// ---- sweep ---------------------------------------------------------------------------------
const recs: Rec[] = [];
const sweepMs: Record<string, number> = {};
function sweep(): void {
  let t = performance.now();
  for (let cx = Math.floor(WB.x0 / CHUNK_SIZE); cx <= Math.floor(WB.x1 / CHUNK_SIZE); cx++) {
    for (let cz = Math.floor(WB.z0 / CHUNK_SIZE); cz <= Math.floor(WB.z1 / CHUNK_SIZE); cz++) {
      const s = residentsForChunk(WORLD_SEED, cx, cz);
      if (s) recs.push(rec('resident', s.type, s.anchorX, s.anchorZ, s.members.length));
    }
  }
  sweepMs.resident = performance.now() - t; t = performance.now();
  for (let cx = Math.floor(WB.x0 / ROAM_CELL); cx <= Math.floor(WB.x1 / ROAM_CELL); cx++) {
    for (let cz = Math.floor(WB.z0 / ROAM_CELL); cz <= Math.floor(WB.z1 / ROAM_CELL); cz++) {
      const s = tryRoamCell(WORLD_SEED, cx, cz);
      if (s) recs.push(rec('roamer', s.type, s.x, s.z, s.members.length));
    }
  }
  sweepMs.roamer = performance.now() - t; t = performance.now();
  for (let cx = Math.floor(WB.x0 / NEAR_CELL); cx <= Math.floor(WB.x1 / NEAR_CELL); cx++) {
    for (let cz = Math.floor(WB.z0 / NEAR_CELL); cz <= Math.floor(WB.z1 / NEAR_CELL); cz++) {
      const s = nearFieldForCell(WORLD_SEED, cx, cz);
      if (s) recs.push(rec('near', s.type, s.anchorX, s.anchorZ, s.members.length));
    }
  }
  sweepMs.near = performance.now() - t; t = performance.now();
  for (const w of wrecksFor(WORLD_SEED)) {
    for (const s of wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS)) recs.push(rec('wreck', s.type, s.anchorX, s.anchorZ, s.members.length));
  }
  const L = instantiateLegend(WORLD_SEED, 'goldbluefin', VIS.goldbluefin);
  if (L) recs.push(rec('legend', L.type, L.cx, L.cz, L.members.length));
  sweepMs.other = performance.now() - t;
}
sweep();

// ---- navigable-water grid (50 m) -----------------------------------------------------------
const GRID = 50;
interface Pt { x: number; z: number; zone: Zone; region: string }
const water: Pt[] = [];
for (let x = WB.x0 + GRID / 2; x < WB.x1; x += GRID) {
  for (let z = WB.z0 + GRID / 2; z < WB.z1; z += GRID) {
    if (landH(x, z) >= 0 || depthAt(x, z) < 1.2) continue; // boat-navigable: water and >= MTI draft
    const zone = zoneAt(x, z);
    water.push({ x, z, zone, region: regionOf(x, z, zone) });
  }
}
const waterKm2 = water.length * GRID * GRID / 1e6;
const boxKm2 = (WB.x1 - WB.x0) * (WB.z1 - WB.z0) / 1e6;

// ---- helpers -------------------------------------------------------------------------------
const f = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : v > 0 ? 'inf' : 'NaN');
const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const rpad = (s: string | number, n: number): string => String(s).padStart(n);
const pct = (a: number, b: number): string => (b ? `${f(100 * a / b)}%` : '-');
function quant(a: number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((p, r) => p - r);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const sum = (a: number[]): number => a.reduce((p, c) => p + c, 0);
const allSpecies = Object.keys(VIS);
const catalog = (r: Rec[]): Map<string, Rec[]> => {
  const m = new Map<string, Rec[]>();
  for (const k of allSpecies) m.set(k, []);
  for (const x of r) { if (!m.has(x.type)) m.set(x.type, []); m.get(x.type)!.push(x); }
  return m;
};
const tableKeysOf = (sp: string): string[] => Object.keys(ZONE_LIFE).filter((k) => ZONE_LIFE[k].some(([n]) => n === sp));
const worldDepthMin = Math.min(...water.map((p) => depthAt(p.x, p.z)));
const worldDepthMax = Math.max(...water.map((p) => depthAt(p.x, p.z)));

describe('ocean census', () => {
  it('sweep summary', () => {
    console.log(`\n=== OCEAN CENSUS  seed=${WORLD_SEED}  box x[${WB.x0},${WB.x1}] z[${WB.z0},${WB.z1}] = ${f(boxKm2)} km2 ===`);
    console.log(`navigable water grid ${GRID} m: ${water.length} pts = ${f(waterKm2)} km2 (${pct(waterKm2, boxKm2)} of box); depth range ${f(worldDepthMin, 2)}..${f(worldDepthMax, 1)} m`);
    console.log(`sweeps: resident ${CHUNK_SIZE} m chunks, roamer ${ROAM_CELL} m cells, near-field ${NEAR_CELL} m cells (ms: ${Object.entries(sweepMs).map(([k, v]) => `${k}=${f(v, 0)}`).join(' ')})`);
    console.log(pad('layer', 10) + rpad('schools', 9) + rpad('fish', 9) + rpad('fish/school', 13) + rpad('species', 9));
    for (const L of LAYERS) {
      const r = recs.filter((x) => x.layer === L);
      console.log(pad(L, 10) + rpad(r.length, 9) + rpad(sum(r.map((x) => x.n)), 9) + rpad(f(sum(r.map((x) => x.n)) / Math.max(1, r.length)), 13) + rpad(new Set(r.map((x) => x.type)).size, 9));
    }
    const m = recs.filter(isMacro);
    console.log(pad('MACRO', 10) + rpad(m.length, 9) + rpad(sum(m.map((x) => x.n)), 9) + rpad(f(sum(m.map((x) => x.n)) / m.length), 13) + rpad(new Set(m.map((x) => x.type)).size, 9));
    console.log(pad('ALL', 10) + rpad(recs.length, 9) + rpad(sum(recs.map((x) => x.n)), 9));
    expect(recs.length).toBeGreaterThan(0);
  });

  it('1. species census + declared-vs-actual flags', () => {
    const byAll = catalog(recs), byMacro = catalog(recs.filter(isMacro));
    const flags: string[] = [];
    console.log('\n--- 1. SPECIES CENSUS (all layers; "macro" = excluding near-field) ---');
    console.log(pad('species', 13) + rpad('schools', 8) + rpad('fish', 8) + rpad('macroSch', 9) + rpad('macroFish', 10) + '  ' +
      pad('declared dMin-dMax', 20) + pad('observed depth min/p50/max', 28) + 'zones (% of schools)');
    const rows = allSpecies.map((sp) => ({ sp, a: byAll.get(sp)!, m: byMacro.get(sp)! })).sort((p, q) => q.a.length - p.a.length);
    for (const { sp, a, m } of rows) {
      const V = VIS[sp];
      const dec = `${V.dMin}-${V.dMax >= 1e5 ? 'inf' : V.dMax}`;
      const ds = a.map((r) => r.depth);
      const zc = new Map<string, number>();
      for (const r of a) zc.set(r.zone, (zc.get(r.zone) ?? 0) + 1);
      const zs = [...zc.entries()].sort((p, q) => q[1] - p[1]).map(([z, c]) => `${z} ${pct(c, a.length)}`).join(', ');
      console.log(pad(sp, 13) + rpad(a.length, 8) + rpad(sum(a.map((r) => r.n)), 8) + rpad(m.length, 9) + rpad(sum(m.map((r) => r.n)), 10) + '  ' +
        pad(dec, 20) + pad(a.length ? `${f(Math.min(...ds))}/${f(quant(ds, 0.5))}/${f(Math.max(...ds))}` : '-', 28) + (zs || '(none placed)'));

      const tabs = tableKeysOf(sp);
      const special = a.filter((r) => r.layer === 'wreck' || r.layer === 'legend').length;
      if (a.length === 0) {
        flags.push(`ABSENT      ${sp}: 0 schools anywhere; in ZONE_LIFE tables [${tabs.join(', ') || 'NONE'}]; declared depth ${dec}`);
        continue;
      }
      if (tabs.length === 0) flags.push(`NO-TABLE    ${sp}: in no ZONE_LIFE table; ${a.length} schools, all from wreck/legend path = ${special === a.length}`);
      const outside = a.filter((r) => r.layer !== 'legend' && (r.depth < V.dMin - 0.5 || r.depth > V.dMax + 0.5));
      if (outside.length) flags.push(`OUT-OF-BAND ${sp}: ${outside.length} schools outside declared ${dec} (e.g. depth ${f(outside[0].depth, 2)} at ${f(outside[0].x, 0)},${f(outside[0].z, 0)} layer ${outside[0].layer})`);
      const hi = Math.min(V.dMax, worldDepthMax), lo = Math.max(V.dMin, worldDepthMin);
      const slack = 0.25 * (hi - lo);
      const dMinObs = Math.min(...ds), dMaxObs = Math.max(...ds);
      if (dMinObs > lo + Math.max(2, slack)) flags.push(`SHALLOW-GAP ${sp}: declared reaches ${f(lo)} m but shallowest school is at ${f(dMinObs)} m`);
      if (dMaxObs < hi - Math.max(5, slack)) flags.push(`DEEP-GAP    ${sp}: declared reaches ${f(hi)} m (min of dMax, world max) but deepest school is at ${f(dMaxObs)} m`);
      const seenHab = new Set(a.filter((r) => r.layer !== 'wreck' && r.layer !== 'legend').map((r) => r.hab));
      const missing = tabs.filter((k) => !seenHab.has(k));
      if (missing.length) flags.push(`DEAD-ENTRY  ${sp}: listed in ZONE_LIFE [${missing.join(', ')}] but 0 schools placed in those habitats (depth band ${dec})`);
    }

    console.log('\n--- 1b. HABITAT TABLE FIDELITY (macro resident+roamer): declared weight share vs observed share ---');
    console.log('      (listed: nominal share >= 1% but observed < 50% of nominal - the depth band / shore gate is eating them)');
    const macro = recs.filter((r) => isMacro(r) && r.layer !== 'wreck' && r.layer !== 'legend');
    for (const key of Object.keys(ZONE_LIFE)) {
      const inKey = macro.filter((r) => r.hab === key);
      const tot = sum(ZONE_LIFE[key].map(([, w]) => w));
      const bad: string[] = [];
      for (const [sp, w] of ZONE_LIFE[key]) {
        const nom = w / tot, obs = inKey.filter((r) => r.type === sp).length / Math.max(1, inKey.length);
        if (nom >= 0.01 && obs < 0.5 * nom) bad.push(`${sp}(${f(100 * nom)}%->${f(100 * obs)}%)`);
      }
      console.log(`${pad(key, 13)} schools=${rpad(inKey.length, 6)} ${bad.length ? 'DISTORTED: ' + bad.join(' ') : 'ok'}`);
    }

    console.log(`\n--- 1c. DECLARED-vs-ACTUAL FLAGS (${flags.length}) ---`);
    for (const x of flags) console.log(x);
    expect(Array.isArray(flags)).toBe(true);
  });

  it('1d. placement invariants (assertions)', () => {
    for (const r of recs) {
      expect(Number.isFinite(r.x) && Number.isFinite(r.z) && Number.isFinite(r.depth)).toBe(true);
      expect(r.n).toBeGreaterThan(0);
      expect(VIS[r.type], `unknown species ${r.type}`).toBeDefined();
      if (r.layer !== 'wreck' && r.layer !== 'legend') {
        expect(r.x >= WB.x0 && r.x <= WB.x1 && r.z >= WB.z0 && r.z <= WB.z1).toBe(true);
        expect(r.depth).toBeGreaterThanOrEqual(VIS[r.type].dMin);
        expect(r.depth).toBeLessThanOrEqual(VIS[r.type].dMax);
      }
    }
    // Dry land. landH >= 0 means the school's anchor is on ground. spawn.ts gates on
    // shoreInfo().d >= 4 (distance to the island OUTLINE) but landH also raises made ground
    // (US-1 causeways, town pad, golf courses, runway - `inFill`) that sits outside the outline, so
    // schools can be anchored on fill. This is a KNOWN BUG (reported, not fixed here): the assertion
    // is a ratchet - it fails if the count ever rises above KNOWN_DRY_LAND, and the test log tells
    // you to lower the constant when it falls. Set to 0 once spawn.ts is fixed.
    const dry = recs.filter((r) => landH(r.x, r.z) >= 0);
    const dryBy = new Map<string, number>();
    for (const r of dry) dryBy.set(`${r.layer}/${r.type}`, (dryBy.get(`${r.layer}/${r.type}`) ?? 0) + 1);
    console.log(`\n--- 1e. SCHOOLS ANCHORED ON DRY LAND (landH >= 0): ${dry.length} of ${recs.length} (${KNOWN_DRY_LAND} known) ---`);
    console.log([...dryBy.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}=${c}`).join(' ') || '(none)');
    for (const r of dry.slice(0, 5)) console.log(`  e.g. ${r.layer} ${r.type} at (${f(r.x, 0)}, ${f(r.z, 0)}) landH=${f(landH(r.x, r.z), 2)} depthAt=${f(r.depth, 2)} dz=${f(r.z - chainZ(r.x), 0)}`);
    expect(dry.length, 'more schools on dry land than the known baseline').toBeLessThanOrEqual(KNOWN_DRY_LAND);
    for (let i = 0; i < 200; i++) {
      const cx = -60 + i, cz = -20 + (i * 7) % 90;
      expect(JSON.stringify(residentsForChunk(WORLD_SEED, cx, cz))).toBe(JSON.stringify(residentsForChunk(WORLD_SEED, cx, cz)));
    }
  });

  it('2. density map (fish per km2 by region and zone)', () => {
    const area = (pred: (p: Pt) => boolean): number => water.filter(pred).length * GRID * GRID / 1e6;
    const rows: Array<[string, number, (r: Rec) => boolean]> = [];
    for (const g of REGIONS) rows.push([`REGION ${g}`, area((p) => p.region === g), (r) => r.region === g]);
    for (const z of ZONES) rows.push([`zone   ${z}`, area((p) => p.zone === z), (r) => r.zone === z]);
    rows.push(['ALL WATER', waterKm2, () => true]);
    console.log(`\n--- 2. DENSITY (fish/km2 and schools/km2; water area from ${GRID} m grid) ---`);
    console.log(pad('region / zone', 26) + rpad('km2', 8) + rpad('macro sch', 10) + rpad('macro fish', 11) + rpad('macro f/km2', 12) + rpad('near fish', 10) + rpad('near f/km2', 11) + rpad('ALL f/km2', 10) + rpad('sch/km2', 9));
    for (const [name, a, pred] of rows) {
      const m = recs.filter((r) => isMacro(r) && pred(r)), nr = recs.filter((r) => r.layer === 'near' && pred(r));
      const mf = sum(m.map((r) => r.n)), nf = sum(nr.map((r) => r.n));
      console.log(pad(name, 26) + rpad(f(a, 1), 8) + rpad(m.length, 10) + rpad(mf, 11) + rpad(f(mf / a, 0), 12) + rpad(nf, 10) + rpad(f(nf / a, 0), 11) + rpad(f((mf + nf) / a, 0), 10) + rpad(f((m.length + nr.length) / a, 1), 9));
    }
    expect(waterKm2).toBeGreaterThan(0);
  });

  it('3. rarity: mean boat distance between encounters (straight transects)', () => {
    // 12 headings (every 15 deg) x 13 parallel lines across the box; navigable samples every 25 m.
    // A school is "met" by a transect if any navigable sample is within R of its (starting)
    // anchor. Mean distance between encounters = navigable path length / total (school, transect)
    // encounters. Roamers and the legend are taken at their starting positions.
    const STEP = 25, HEADINGS = 12, LINES = 13;
    const cxm = (WB.x0 + WB.x1) / 2, czm = (WB.z0 + WB.z1) / 2, half = Math.hypot(WB.x1 - WB.x0, WB.z1 - WB.z0) / 2;
    const samples: Array<{ t: number; x: number; z: number }> = [];
    let pathLen = 0;
    let tid = 0;
    for (let h = 0; h < HEADINGS; h++) {
      const a = (h * Math.PI) / HEADINGS, dx = Math.cos(a), dz = Math.sin(a);
      for (let l = 0; l < LINES; l++) {
        const off = ((l + 0.5) / LINES - 0.5) * 2 * half * 0.9;
        const bx = cxm - dz * off, bz = czm + dx * off;
        let any = false;
        for (let s = -half; s <= half; s += STEP) {
          const x = bx + dx * s, z = bz + dz * s;
          if (x < WB.x0 || x > WB.x1 || z < WB.z0 || z > WB.z1) continue;
          if (landH(x, z) >= 0 || depthAt(x, z) < 1.2) continue;
          samples.push({ t: tid, x, z }); pathLen += STEP; any = true;
        }
        if (any) tid++;
      }
    }
    const radii = [100, 300];
    console.log(`\n--- 3. RARITY: ${tid} transects, ${f(pathLen / 1000, 0)} km of navigable track (${HEADINGS} headings x ${LINES} lines, ${STEP} m steps) ---`);
    console.log('   macro = resident+roamer+wreck+legend; +near = also near-field cells. Metres between encounters (inf = never met); enc = macro encounters.');
    const results: Record<number, Map<string, { macro: number; all: number }>> = {};
    for (const R of radii) {
      const grid = new Map<string, number[]>();
      samples.forEach((s, i) => {
        const k = `${Math.floor(s.x / R)},${Math.floor(s.z / R)}`;
        let g = grid.get(k); if (!g) grid.set(k, g = []);
        g.push(i);
      });
      const out = new Map<string, { macro: number; all: number }>();
      for (const sp of allSpecies) out.set(sp, { macro: 0, all: 0 });
      for (const r of recs) {
        const cx = Math.floor(r.x / R), cz = Math.floor(r.z / R);
        const hit = new Set<number>();
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
          const g = grid.get(`${cx + i},${cz + j}`);
          if (!g) continue;
          for (const si of g) { const s = samples[si]; if (Math.hypot(s.x - r.x, s.z - r.z) <= R) hit.add(s.t); }
        }
        const o = out.get(r.type)!;
        o.all += hit.size; if (isMacro(r)) o.macro += hit.size;
      }
      results[R] = out;
    }
    const dist = (n: number): string => (n ? f(pathLen / n, 0) : 'inf');
    console.log(pad('species', 13) + radii.map((R) => rpad(`R${R} macro`, 12) + rpad(`R${R} +near`, 12) + rpad('enc', 6)).join(''));
    const order = [...allSpecies].sort((p, q) => (results[100].get(q)!.all) - (results[100].get(p)!.all));
    for (const sp of order) {
      console.log(pad(sp, 13) + radii.map((R) => { const o = results[R].get(sp)!; return rpad(dist(o.macro), 12) + rpad(dist(o.all), 12) + rpad(o.macro, 6); }).join(''));
    }
    const never = allSpecies.filter((sp) => results[300].get(sp)!.all === 0);
    console.log(`never met within 300 m on any transect (${never.length}): ${never.join(', ') || '-'}`);
    const rare = allSpecies.filter((sp) => { const n = results[300].get(sp)!.macro; return n > 0 && pathLen / n > 50000; });
    console.log(`met but > 50 km between macro encounters at R300 (${rare.length}): ${rare.join(', ') || '-'}`);
    expect(pathLen).toBeGreaterThan(0);
  });

  it('4. the gold bluefin legend school', () => {
    const L = instantiateLegend(WORLD_SEED, 'goldbluefin', VIS.goldbluefin);
    console.log('\n--- 4. THE GOLD BLUEFIN ---');
    expect(L, 'legend school must exist').not.toBeNull();
    const l = L!;
    const d = depthAt(l.cx, l.cz), z = zoneAt(l.cx, l.cz), si = shoreInfo(l.cx, l.cz), dz = l.cz - chainZ(l.cx);
    const second = instantiateLegend(WORLD_SEED, 'goldbluefin', VIS.goldbluefin)!;
    const memberFar = Math.max(...l.members.map((m) => Math.hypot(m.ox, m.oz)));
    console.log(`type=${l.type} members=${l.members.length} start=(${f(l.cx, 1)}, ${f(l.cz, 1)}) heading=${f(l.heading, 3)} rad`);
    console.log(`depth=${f(d, 1)} m (declared dMin ${VIS.goldbluefin.dMin}, legend needs >= 14) zone=${z} dz-from-chain=${f(dz, 0)} m shore dist=${f(si.d, 0)} m (needs >= 60) landH=${f(landH(l.cx, l.cz), 2)}`);
    console.log(`inside sailable box: ${l.cx >= WB.x0 && l.cx <= WB.x1 && l.cz >= WB.z0 && l.cz <= WB.z1}; member spread ${f(memberFar, 1)} m; nearest island: ${si.isl?.name ?? 'none'}`);
    console.log(`deterministic on re-roll: ${second.cx === l.cx && second.cz === l.cz}`);
    expect(l.members.length).toBe(3);
    expect(Number.isFinite(l.cx) && Number.isFinite(l.cz)).toBe(true);
    expect(l.cx >= WB.x0 && l.cx <= WB.x1 && l.cz >= WB.z0 && l.cz <= WB.z1).toBe(true);
    expect(landH(l.cx, l.cz)).toBeLessThan(0);
    expect(d).toBeGreaterThanOrEqual(14);
    expect(si.d).toBeGreaterThanOrEqual(60);
    expect(second.cx).toBe(l.cx);
  });

  it('5. dead water: share of navigable water with no fish within R metres', () => {
    // Nearest-school distance from every navigable grid point, via a 100 m hash with expanding
    // rings (exact up to MAXR; beyond that reported as ">MAXR").
    const C = 100, MAXR = 2000;
    const build = (pred: (r: Rec) => boolean): Map<string, Rec[]> => {
      const g = new Map<string, Rec[]>();
      for (const r of recs) if (pred(r)) {
        const k = `${Math.floor(r.x / C)},${Math.floor(r.z / C)}`;
        let a = g.get(k); if (!a) g.set(k, a = []);
        a.push(r);
      }
      return g;
    };
    const nearest = (g: Map<string, Rec[]>, p: Pt): number => {
      const cx = Math.floor(p.x / C), cz = Math.floor(p.z / C);
      let best = Infinity;
      for (let ring = 0; ring <= MAXR / C; ring++) {
        if (best <= (ring - 1) * C) break; // nothing in an outer ring can beat best
        for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const a = g.get(`${cx + i},${cz + j}`);
          if (a) for (const r of a) best = Math.min(best, Math.hypot(r.x - p.x, r.z - p.z));
        }
      }
      return best;
    };
    const variants: Array<[string, (r: Rec) => boolean]> = [
      ['macro (surface boat sees)', isMacro],
      ['macro, catchable only', (r) => isMacro(r) && VIS[r.type].catchable !== false],
      ['macro, big (len>=0.85 m)', (r) => isMacro(r) && VIS[r.type].len >= 0.85],
      ['all layers incl. near-field', () => true],
    ];
    const radii = [50, 100, 200, 400];
    console.log(`\n--- 5. DEAD WATER: % of navigable water (${GRID} m grid, ${water.length} pts) with NO school anchor within R ---`);
    console.log(pad('definition', 28) + radii.map((R) => rpad(`ALL R${R}`, 10)).join('') + '   ' + 'nearest-school distance m: p50 / p95 / max');
    let firstDead200 = 0;
    for (const [vi, [name, pred]] of variants.entries()) {
      const g = build(pred);
      const dist = water.map((p) => nearest(g, p));
      if (vi === 0) firstDead200 = dist.filter((d) => d > 200).length / water.length;
      console.log(pad(name, 28) + radii.map((R) => rpad(pct(dist.filter((d) => d > R).length, dist.length), 10)).join('') +
        `   ${f(quant(dist, 0.5), 0)} / ${f(quant(dist, 0.95), 0)} / ${f(Math.max(...dist), 0)}`);
      console.log(pad('   by region (R200 / R400)', 28) + REGIONS.map((reg) => {
        const idx = water.map((p, i) => (p.region === reg ? i : -1)).filter((i) => i >= 0);
        return `${reg}: ${pct(idx.filter((i) => dist[i] > 200).length, idx.length)}/${pct(idx.filter((i) => dist[i] > 400).length, idx.length)}  `;
      }).join(''));
    }
    console.log('(school anchors tested; members sit within the species spread (<~10 m) of the anchor)');
    expect(firstDead200).toBeGreaterThanOrEqual(0);
    expect(firstDead200).toBeLessThanOrEqual(1);
  });
});
