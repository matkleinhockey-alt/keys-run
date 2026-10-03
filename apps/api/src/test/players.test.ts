import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/client.js';
import { recordCatch } from '../lib/records.js';
import { buildTestApp, registerUser, testDbHandle, truncateAll } from './helpers.js';

describe('GET /players/:id/records', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(() => {
    handle = testDbHandle();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
    app = await buildTestApp(handle);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns {best, sp, count} — the shape legacy’s LB.mine renders', async () => {
    const user = await registerUser(app, { displayName: 'Record Holder' });
    await recordCatch(handle.db, { userId: user.id, speciesKey: 'tarpon', weightLb: 90 });
    await recordCatch(handle.db, { userId: user.id, speciesKey: 'mahi', weightLb: 150 });
    await recordCatch(handle.db, { userId: user.id, speciesKey: 'tarpon', weightLb: 40 }); // not a new species best

    const res = await app.inject({ method: 'GET', url: `/players/${user.id}/records` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      best: { key: 'mahi', weight: 150 },
      sp: { tarpon: 90, mahi: 150 },
      count: 3,
    });
  });

  it('returns a zeroed shape for a player with no catches', async () => {
    const user = await registerUser(app, { displayName: 'Zero Catches' });
    const res = await app.inject({ method: 'GET', url: `/players/${user.id}/records` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ best: null, sp: {}, count: 0 });
  });

  it('404s for an unknown player id', async () => {
    const res = await app.inject({ method: 'GET', url: '/players/00000000-0000-0000-0000-000000000000/records' });
    expect(res.statusCode).toBe(404);
  });

  it('400s for a malformed id', async () => {
    const res = await app.inject({ method: 'GET', url: '/players/not-a-uuid/records' });
    expect(res.statusCode).toBe(400);
  });
});
