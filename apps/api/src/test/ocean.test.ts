import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/client.js';
import { buildTestApp, registerUser, loginUser, testDbHandle, truncateAll } from './helpers.js';
import { CELL_BOUNDS, MAX_OCEAN_BATCH } from '../routes/ocean.js';

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
    expect(second.json().pressure).toBe(3.5);
    const { cells } = (await read('3,4')).json();
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ cx: 3, cz: 4, pressure: 3.5 });
    expect(new Date(cells[0].lastCaughtAt).getTime()).toBeGreaterThan(0);
    const rows = (await handle.pool.query('SELECT count(*)::int AS n FROM ocean_cells')).rows as { n: number }[];
    expect(rows[0].n).toBe(1);
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
