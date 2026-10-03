import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbHandle } from '../db/client.js';
import { createDb } from '../db/client.js';
import { buildTestApp, testDbHandle, truncateAll } from './helpers.js';

describe('GET /health', () => {
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

  it('returns 200 when the database is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when the database is unreachable', async () => {
    // Point at a port nothing is listening on — the pool will fail to
    // connect, which is exactly what "database unreachable" means in
    // production (network partition, Postgres down, etc).
    const deadHandle = createDb('postgres://keysrun:keysrun_dev_password@127.0.0.1:1/keysrun');
    const deadApp = await buildTestApp(deadHandle);
    try {
      const res = await deadApp.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable' });
    } finally {
      await deadApp.close();
      await deadHandle.close();
    }
  });
});
