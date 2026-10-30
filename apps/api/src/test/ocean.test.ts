import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/client.js';
import { buildTestApp, registerUser, loginUser, testDbHandle, truncateAll } from './helpers.js';
import { CELL_BOUNDS, MAX_OCEAN_BATCH } from '../routes/ocean.js';
import { PRESSURE_CAP, PRESSURE_HALF_LIFE_HOURS, pressureAfterCatch } from '@keysrun/shared/sim/ocean';

describe('ocean ledger', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(() => { handle = testDbHandle(); });
  afterAll(async () => { await handle.close(); });
  beforeEach(async () => { await truncateAll(handle); app = await buildTestApp(handle); });
  afterEach(async () => { await app.close(); });

  async function token(): Promise<string> {
    const u = await registerUser(app);
    return (await loginUser(app, u.email, u.password)).token;
  }
  const read = (cells: string) => app.inject({ method: 'GET', url: `/ocean?cells=${encodeURIComponent(cells)}` });
  const fish = (t: string | null, payload: unknown) =>
    app.inject({ method: 'POST', url: '/ocean/catch', headers: t ? { authorization: `Bearer ${t}` } : {}, payload: payload as object });

  it('returns nothing for pristine cells', async () => {
    const res = await read('3,4');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cells: [] });
  });

  it('creates a row on the first catch and accumulates on the second', async () => {
    const t = await token();
    const first = await fish(t, { cx: 3, cz: 4 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ cx: 3, cz: 4, pressure: 1 });
    const second = await fish(t, { cx: 3, cz: 4, amount: 2.5 });
    // Not `toBe(3.5)`: a write decays the stored pressure across the elapsed time first, and the
    // milliseconds between these two requests are real elapsed time, so this lands a hair under
    // (3.499999935... in practice). Exact equality here would be asserting that the clock stood
    // still. The decay itself is pinned below.
    expect(second.json().pressure).toBeCloseTo(3.5, 4);
    const { cells } = (await read('3,4')).json();
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ cx: 3, cz: 4 });
    expect(cells[0].pressure).toBeCloseTo(3.5, 4);
    expect(new Date(cells[0].lastCaughtAt).getTime()).toBeGreaterThan(0);
    const rows = (await handle.pool.query('SELECT count(*)::int AS n FROM ocean_cells')).rows as { n: number }[];
    expect(rows[0].n).toBe(1);
  });

  /**
   * A row holds one `pressure` as of one `lastCaughtAt`, so a write that added without ageing
   * first would sum catches from different weeks as one session: a spot fished once a week would
   * climb to the cap and stay sour forever. These pin the SQL against `pressureAfterCatch`, the
   * model the client reads with — if the two drift, depletion stops recovering.
   */
  describe('a write decays the stored pressure before adding to it', () => {
    /** Backdates a cell so the next catch has real elapsed time to decay across. */
    const age = (cx: number, cz: number, hours: number) =>
      handle.pool.query(
        "UPDATE ocean_cells SET last_caught_at = now() - ($1 || ' hours')::interval WHERE cx = $2 AND cz = $3",
        [String(hours), cx, cz],
      );

    it('halves across one half-life, so 30 + a catch a day later is 16, not 31', async () => {
      const t = await token();
      await fish(t, { cx: 8, cz: 8, amount: 30 });
      await age(8, 8, PRESSURE_HALF_LIFE_HOURS);
      const res = await fish(t, { cx: 8, cz: 8 });
      expect(res.json().pressure).toBeCloseTo(pressureAfterCatch(30, PRESSURE_HALF_LIFE_HOURS), 6);
      expect(res.json().pressure).toBeCloseTo(16, 6);
    });

    it('a week of rest leaves almost nothing behind', async () => {
      const t = await token();
      await fish(t, { cx: 8, cz: 9, amount: 17 });
      await age(8, 9, 24 * 7);
      const res = await fish(t, { cx: 8, cz: 9 });
      expect(res.json().pressure).toBeCloseTo(pressureAfterCatch(17, 24 * 7), 6);
      expect(res.json().pressure).toBeLessThan(1.2);
    });

    it('back-to-back catches do not decay, so a grind still bites', async () => {
      const t = await token();
      await fish(t, { cx: 8, cz: 10 });
      const res = await fish(t, { cx: 8, cz: 10 });
      expect(res.json().pressure).toBeCloseTo(2, 3);
    });

    it('never exceeds the cap, however hard a cell is hammered', async () => {
      const t = await token();
      for (let i = 0; i < 4; i++) await fish(t, { cx: 8, cz: 11, amount: 100 });
      const { cells } = (await read('8,11')).json();
      expect(cells[0].pressure).toBeLessThanOrEqual(PRESSURE_CAP);
      expect(cells[0].pressure).toBe(PRESSURE_CAP);
    });

    it('a clock that stepped backwards counts as no rest, not negative rest', async () => {
      const t = await token();
      await fish(t, { cx: 8, cz: 12, amount: 10 });
      await age(8, 12, -48); // last_caught_at in the future
      const res = await fish(t, { cx: 8, cz: 12 });
      // GREATEST(0, ...) in the SQL: decay factor 1, so this is a plain +1, never a blow-up
      expect(res.json().pressure).toBeCloseTo(11, 6);
    });
  });

  it('batch-reads several cells, returning only the disturbed ones (negative coords too)', async () => {
    const t = await token();
    await fish(t, { cx: 1, cz: 1 });
    await fish(t, { cx: -5, cz: 10 });
    const { cells } = (await read('1,1;-5,10;7,7;1,1')).json();
    expect(cells.map((c: { cx: number; cz: number }) => `${c.cx},${c.cz}`).sort()).toEqual(['-5,10', '1,1']);
  });

  it('rejects an oversized or malformed batch', async () => {
    const ok = Array.from({ length: MAX_OCEAN_BATCH }, (_, i) => `${i % 60},${Math.floor(i / 60)}`).join(';');
    expect((await read(ok)).statusCode).toBe(200);
    expect((await read(`${ok};0,50`)).statusCode).toBe(400);
    expect((await read('')).statusCode).toBe(400);
    expect((await read('1,2;oops')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/ocean' })).statusCode).toBe(400);
  });

  it('rejects cells outside the world box', async () => {
    const t = await token();
    const { cx1, cz0, cx0, cz1 } = CELL_BOUNDS;
    expect((await read(`${cx1 + 1},0`)).statusCode).toBe(400);
    expect((await read(`0,${cz0 - 1}`)).statusCode).toBe(400);
    expect((await fish(t, { cx: cx0 - 1, cz: 0 })).statusCode).toBe(400);
    expect((await fish(t, { cx: 0, cz: cz1 + 1 })).statusCode).toBe(400);
    expect((await fish(t, { cx: 1.5, cz: 0 })).statusCode).toBe(400);
    expect((await fish(t, { cx: 0, cz: 0, amount: -1 })).statusCode).toBe(400);
    expect((await fish(t, { cx: 0, cz: 0, amount: 1e9 })).statusCode).toBe(400);
    // the corners of the box are fishable
    expect((await fish(t, { cx: cx1, cz: cz1 })).statusCode).toBe(200);
    expect((await fish(t, { cx: cx0, cz: cz0 })).statusCode).toBe(200);
  });

  it('refuses a catch without a session and writes nothing', async () => {
    expect((await fish(null, { cx: 0, cz: 0 })).statusCode).toBe(401);
    expect((await read('0,0')).json()).toEqual({ cells: [] });
  });
});
