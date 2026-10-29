import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/client.js';
import { buildTestApp, registerUser, loginUser, testDbHandle, truncateAll } from './helpers.js';

describe('game saves', () => {
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
  const get = (t: string) => app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${t}` } });
  const put = (t: string, data: unknown) => app.inject({ method: 'PUT', url: '/save', headers: { authorization: `Bearer ${t}` }, payload: { data } });

  it('starts empty, then keeps exactly what was saved, per account', async () => {
    const a = await token(), b = await token();
    expect((await get(a)).json()).toEqual({ data: null, updatedAt: null });
    const data = { 'keysrun.economy.v1': { v: 1, cash: 12345, owned: ['skiff'] }, 'keysrun.inventory.v1': { inventory: {} } };
    expect((await put(a, data)).statusCode).toBe(200);
    expect((await get(a)).json()).toMatchObject({ data });
    expect((await get(b)).json()).toMatchObject({ data: null });
    const next = { 'keysrun.economy.v1': { v: 1, cash: 1 } };
    await put(a, next);
    expect((await get(a)).json().data).toEqual(next);
    // stored as JSON, so the database can read the wallet
    const [row] = (await handle.pool.query(`SELECT data->'keysrun.economy.v1'->>'cash' AS cash FROM player_saves`)).rows as { cash: string }[];
    expect(row.cash).toBe('1');
  });

  it('needs a session, and refuses keys that are not the game\'s or a save that is too big', async () => {
    expect((await app.inject({ method: 'GET', url: '/save' })).statusCode).toBe(401);
    const a = await token();
    expect((await put(a, { 'keysrun.session.v1': 'x', other: 'y' })).statusCode).toBe(400);
    expect((await put(a, { 'keysrun.economy.v1': 'x'.repeat(600 * 1024) })).statusCode).toBe(413);
  });

  it('lets a browser PUT it (the CORS preflight allows the method)', async () => {
    const res = await app.inject({
      method: 'OPTIONS', url: '/save',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.headers['access-control-allow-methods']).toContain('PUT');
  });
});
