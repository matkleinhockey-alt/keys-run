/**
 * net/ocean.ts wired to the weight roll, against a fake /ocean that behaves like
 * apps/api/src/routes/ocean.ts (additive upserts, 400 on any cell outside the world, 256 cap).
 *
 * Proves: (a) signed out or with the API down, the game's fish are exactly today's; (b) a cell
 * with recorded pressure yields the smaller fish sim/ocean.ts says it should; (c) sailing and
 * hovering on chunk boundaries makes a bounded handful of requests, not one per crossing;
 * and prints the measured play loop (30 catches, then a day away).
 */
import { describe, expect, it } from 'vitest';
import { WB } from '@keysrun/shared/world/depth';
import { chooseFish } from '@keysrun/shared/sim/fight';
import { SPECIES } from '@keysrun/shared/content/species';
import { applyOceanSize, recovery, sizeScale } from '@keysrun/shared/sim/ocean';
import { mulberry32 } from '@keysrun/shared/rng';
import { createOceanLedger, CELL_SIZE, MAX_BATCH, TTL_MS, type OceanEnv } from '../src/net/ocean.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12);
const me = { token: 't', userId: 'u1', displayName: 'Me' };

/** A fake server with the real route's rules. */
function fakeServer() {
  const rows = new Map<string, { pressure: number; last: number }>();
  const log = { gets: [] as number[], posts: 0, down: false };
  const cx0 = Math.floor(WB.x0 / CELL_SIZE), cx1 = Math.floor(WB.x1 / CELL_SIZE);
  const cz0 = Math.floor(WB.z0 / CELL_SIZE), cz1 = Math.floor(WB.z1 / CELL_SIZE);
  const clock = { now: T0 };
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    if (log.down) throw new TypeError('fetch failed');
    const u = new URL(url);
    if (u.pathname === '/ocean') {
      const parts = (u.searchParams.get('cells') ?? '').split(';');
      log.gets.push(parts.length);
      if (parts.length > MAX_BATCH) return new Response(null, { status: 400 });
      const out = [];
      for (const p of parts) {
        const [cx, cz] = p.split(',').map(Number);
        if (!(cx >= cx0 && cx <= cx1 && cz >= cz0 && cz <= cz1)) return new Response(null, { status: 400 });
        const r = rows.get(p);
        if (r) out.push({ cx, cz, pressure: r.pressure, lastCaughtAt: new Date(r.last).toISOString() });
      }
      return Response.json({ cells: out });
    }
    if (u.pathname === '/ocean/catch') {
      log.posts++;
      const { cx, cz, amount = 1 } = JSON.parse(init.body as string) as { cx: number; cz: number; amount?: number };
      const k = `${cx},${cz}`;
      const r = rows.get(k);
      const row = { pressure: (r?.pressure ?? 0) + amount, last: clock.now };
      rows.set(k, row);
      return Response.json({ cx, cz, pressure: row.pressure, lastCaughtAt: new Date(row.last).toISOString() });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { rows, log, clock, fetchFn };
}

function ledger(srv: ReturnType<typeof fakeServer>, signedIn = true) {
  const env: OceanEnv = { session: () => (signedIn ? me : null), fetch: srv.fetchFn, now: () => srv.clock.now, baseUrl: 'http://api.test' };
  return createOceanLedger(env);
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
/** Boat sits at (x, z) for `ms` of game-clock time, ticking at 10 Hz and letting requests land. */
async function sit(srv: ReturnType<typeof fakeServer>, l: ReturnType<typeof ledger>, x: number, z: number, ms: number) {
  for (let t = 0; t < ms; t += 100) { srv.clock.now += 100; l.update(x, z); await settle(); }
}
const cellMid = (c: number) => (c + 0.5) * CELL_SIZE;

describe('offline is exactly today\'s game', () => {
  it('signed out: no requests, every cell pristine, nothing stored', async () => {
    const srv = fakeServer();
    const l = ledger(srv, false);
    for (let i = 0; i < 500; i++) { l.update(i * 10, i * 7); expect(l.recoveryAt(i * 10, i * 7)).toBe(1); }
    l.recordCatch(100, 100);
    await settle();
    expect(l.recoveryAt(100, 100)).toBe(1);
    expect(srv.log.gets.length + srv.log.posts).toBe(0);
    expect(l.stats()).toEqual({ gets: 0, posts: 0, cached: 0 });
  });

  it('signed in but the API is down: still pristine, no throw, backoff bounds the retries', async () => {
    const srv = fakeServer();
    srv.log.down = true;
    const l = ledger(srv);
    let attempts = 0;
    const inner = srv.fetchFn;
    const counting = ((...a: Parameters<typeof fetch>) => { attempts++; return inner(...a); }) as typeof fetch;
    const dead = createOceanLedger({ session: () => me, fetch: counting, now: () => srv.clock.now, baseUrl: 'http://api.test' });
    for (let t = 0; t < 120_000; t += 100) { srv.clock.now += 100; dead.update(0, 0); expect(dead.recoveryAt(0, 0)).toBe(1); if (t % 1000 === 0) await settle(); }
    await settle();
    // two minutes of a dead API: 2, 4, 8, 16, 32 s then 60 s gaps - a handful, not 1,200 frames' worth
    expect(attempts).toBeLessThanOrEqual(8);
    void l;
  });

  it('with no pressure the roll is bit-identical to the legacy roll, for the whole seeded sequence', () => {
    const N = 5000;
    for (const rec of [undefined, 1] as const) {
      const a = mulberry32(42), b = mulberry32(42);
      for (let i = 0; i < N; i++) {
        const zone = i % 3 === 0 ? 'Offshore' : i % 3 === 1 ? 'Reef' : 'Wreck';
        const bob = { x: (i * 37) % 3000, z: (i * 91) % 3000 };
        const hs = i % 5 === 0;
        const got = chooseFish(zone, bob, { hotspot: hs, hump: null, recovery: rec }, a);
        const want = chooseFish(zone, bob, { hotspot: hs, hump: null }, b);
        expect(got).toEqual(want); // same species, weight to the last digit, same position
      }
    }
    // and the weight is exactly rollWeight's own value, never re-derived or re-rounded
    const bob = { x: 10, z: 10 };
    const f = chooseFish('Reef', bob, { hotspot: false, hump: null, recovery: 1 }, mulberry32(7));
    const twin = mulberry32(7);
    const species = chooseFish('Reef', bob, { hotspot: false, hump: null }, twin).key;
    expect(species).toBe(f.key);
    expect(f.weight).toBe(+f.weight.toFixed(1));
  });
});

describe('fished water yields smaller fish, by sim/ocean.ts\'s own numbers', () => {
  it('a disturbed cell comes down from the server and scales the roll', async () => {
    const srv = fakeServer();
    srv.rows.set('3,4', { pressure: 30, last: T0 });
    const l = ledger(srv);
    await sit(srv, l, cellMid(3), cellMid(4), 2000);
    const rec = l.recoveryAt(cellMid(3), cellMid(4));
    expect(rec).toBeCloseTo(recovery(30, (srv.clock.now - T0) / HOUR), 12); // 2 s of the test's own clock has passed
    expect(l.recoveryAt(cellMid(5), cellMid(4))).toBe(1); // next door: untouched

    // same rng stream, pristine vs fished: the fished fish is the pristine one scaled and clamped
    let smaller = 0;
    for (let i = 0; i < 400; i++) {
      const zone = 'Reef', bob = { x: cellMid(3), z: cellMid(4) };
      const base = chooseFish(zone, bob, { hotspot: false, hump: null }, mulberry32(i));
      const fished = chooseFish(zone, bob, { hotspot: false, hump: null, recovery: rec }, mulberry32(i));
      const S = SPECIES[base.key];
      expect(fished.key).toBe(base.key);
      expect(fished.weight).toBeCloseTo(applyOceanSize(base.weight, S.min, S.max, rec), 1);
      expect(fished.weight).toBeLessThanOrEqual(base.weight);
      expect(fished.weight).toBeGreaterThanOrEqual(S.min);
      if (fished.weight < base.weight) smaller++;
    }
    expect(smaller).toBeGreaterThan(300);
    expect(sizeScale(rec)).toBeLessThan(0.7); // 30 catches: a third off
  });

  it('a landed catch thins the spot at once and is reported once', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    await sit(srv, l, 100, 100, 2000);
    const x = 100, z = 100;
    expect(l.recoveryAt(x, z)).toBe(1);
    l.recordCatch(x, z);
    expect(l.recoveryAt(x, z)).toBeLessThan(1); // before the POST has even returned
    await settle();
    expect(srv.log.posts).toBe(1);
    expect(srv.rows.get('1,1')?.pressure).toBe(1);
  });

  it('catches made while the API is down are kept, and sent when it returns', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    await sit(srv, l, 100, 100, 2000);
    srv.log.down = true;
    for (let i = 0; i < 5; i++) l.recordCatch(100, 100);
    await settle();
    expect(l.recoveryAt(100, 100)).toBeLessThan(1);
    expect(srv.rows.size).toBe(0);
    srv.log.down = false;
    srv.clock.now += 3000;
    await new Promise((r) => setTimeout(r, 2200)); // the retry timer (real time, 2 s backoff)
    expect(srv.rows.get('1,1')?.pressure).toBe(5);
  });
});

describe('no request storm', () => {
  it('hovering across one chunk boundary 1,000 times costs nothing after the first look', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    const edge = 10 * CELL_SIZE;
    await sit(srv, l, edge - 1, 500, 3000);
    const before = srv.log.gets.length;
    for (let i = 0; i < 1000; i++) { srv.clock.now += 100; l.update(edge + (i % 2 ? 1 : -1), 500); if (i % 50 === 0) await settle(); }
    await settle();
    expect(before).toBe(1);
    expect(srv.log.gets.length - before).toBeLessThanOrEqual(1);
  });

  it('a long straight run asks only for new cells, in few, small requests', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    // 100 chunks at ~25 units/s (a hard-running boat), 10 Hz.
    const z = 500;
    for (let x = 0; x < 100 * CELL_SIZE; x += 2.5) { srv.clock.now += 100; l.update(x, z); await settle(); }
    const total = srv.log.gets.reduce((a, b) => a + b, 0);
    console.log(`ocean-net: 100-chunk run -> ${srv.log.gets.length} GETs, ${total} cells asked, max batch ${Math.max(...srv.log.gets)}, cached ${l.stats().cached}`);
    expect(srv.log.gets.length).toBeLessThanOrEqual(110); // one per crossing at most, never per frame (2,560 frames)
    expect(Math.max(...srv.log.gets)).toBeLessThanOrEqual(49 + 7); // the window, never more
    expect(total).toBeLessThanOrEqual(49 + 7 * 100 + 49 * 2); // window once, then a column per chunk (+ TTL refresh)
  });

  it('a fast boat\'s crossings within the gap coalesce into one request', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    await sit(srv, l, 32, 32, 200);
    const after = srv.log.gets.length;
    // five chunks in 500 ms
    for (let i = 1; i <= 5; i++) { srv.clock.now += 100; l.update(32 + i * CELL_SIZE, 32); await settle(); }
    expect(srv.log.gets.length - after).toBeLessThanOrEqual(1);
  });

  it('refetches only after the TTL, and only what went stale', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    await sit(srv, l, 100, 100, 2000);
    const n = srv.log.gets.length;
    await sit(srv, l, 100, 100, TTL_MS - 5000);
    expect(srv.log.gets.length).toBe(n);
    await sit(srv, l, 100, 100, 40_000);
    expect(srv.log.gets.length).toBe(n + 1);
  });

  it('keeps the window inside the world so the server never 400s the batch', async () => {
    const srv = fakeServer();
    const l = ledger(srv);
    await sit(srv, l, WB.x0 + 1, WB.z0 + 1, 2000);
    await sit(srv, l, WB.x1 - 1, WB.z1 - 1, 2000);
    expect(srv.log.gets.length).toBe(2);
    expect(l.stats().cached).toBeGreaterThan(0);
  });
});

describe('the play loop, measured', () => {
  it('mutton snapper, median roll: pristine -> 30 catches in one cell -> a day later', async () => {
    const S = SPECIES.mutton;
    const roll = (S.min + S.max) / 2;
    const srv = fakeServer();
    const l = ledger(srv);
    const x = cellMid(2), z = cellMid(2);
    await sit(srv, l, x, z, 2000);
    const weightHere = () => applyOceanSize(roll, S.min, S.max, l.recoveryAt(x, z));
    const pristine = weightHere();
    for (let i = 0; i < 30; i++) {
      srv.clock.now += 2 * 60_000; // a catch every two minutes
      l.recordCatch(x, z);
      await settle();
    }
    const hour = weightHere();
    srv.clock.now += 24 * HOUR;
    const dayLater = weightHere();
    // the same day, but a fresh session: the cell comes from the server, not this tab's memory
    const fresh = ledger(srv);
    await sit(srv, fresh, x, z, 2000);
    const freshDay = applyOceanSize(roll, S.min, S.max, fresh.recoveryAt(x, z));
    console.log(`ocean-net play loop (mutton ${roll} lb): pristine ${pristine} lb -> after 30 catches ${hour.toFixed(2)} lb -> a day later ${dayLater.toFixed(2)} lb (fresh session ${freshDay.toFixed(2)} lb); server pressure ${srv.rows.get('2,2')?.pressure}`);
    expect(pristine).toBe(roll);
    expect(hour).toBeLessThan(roll * 0.8);
    expect(dayLater).toBeGreaterThan(hour);
    expect(dayLater).toBeLessThan(roll);
    expect(freshDay).toBeCloseTo(dayLater, 2); // two clocks, 2 s apart
  });
});
