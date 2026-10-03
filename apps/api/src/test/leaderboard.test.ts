import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SPECIES } from '@keysrun/shared/content/species';
import type { DbHandle } from '../db/client.js';
import { users, players } from '../db/schema.js';
import { recordCatch } from '../lib/records.js';
import { buildTestApp, registerUser, testDbHandle, truncateAll } from './helpers.js';

/**
 * Inserts a user directly (no argon2 hashing — these users are never logged
 * in). Used only for bulk fixtures where real password hashing would make
 * the test needlessly slow; see "caps /leaderboard/overall at 100 rows".
 */
async function insertBareUser(handle: DbHandle, displayName: string): Promise<{ id: string }> {
  const [row] = await handle.db
    .insert(users)
    .values({ email: `${displayName.toLowerCase().replace(/\s+/g, '-')}@keysrun.test`, passwordHash: 'unused', displayName })
    .returning({ id: users.id });
  await handle.db.insert(players).values({ userId: row.id });
  return row;
}

describe('leaderboard', () => {
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

  it('orders /leaderboard/overall by each player’s best catch, descending', async () => {
    const low = await registerUser(app, { displayName: 'Low Weight' });
    const mid = await registerUser(app, { displayName: 'Mid Weight' });
    const high = await registerUser(app, { displayName: 'High Weight' });

    await recordCatch(handle.db, { userId: low.id, speciesKey: 'bonefish', weightLb: 5 });
    await recordCatch(handle.db, { userId: mid.id, speciesKey: 'tarpon', weightLb: 90 });
    await recordCatch(handle.db, { userId: high.id, speciesKey: 'bluefin', weightLb: 400 });
    // A second, smaller catch for `high` must not override their best.
    await recordCatch(handle.db, { userId: high.id, speciesKey: 'mahi', weightLb: 10 });

    const res = await app.inject({ method: 'GET', url: '/leaderboard/overall' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ rank: number; displayName: string; weightLb: number; catchCount: number }> };

    expect(body.rows.map((r) => r.displayName)).toEqual(['High Weight', 'Mid Weight', 'Low Weight']);
    expect(body.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    const highRow = body.rows.find((r) => r.displayName === 'High Weight');
    expect(highRow?.weightLb).toBe(400);
    expect(highRow?.catchCount).toBe(2);
  });

  it('caps /leaderboard/overall at 100 rows', async () => {
    for (let i = 0; i < 105; i++) {
      const user = await insertBareUser(handle, `Bulk ${i}`);
      await recordCatch(handle.db, { userId: user.id, speciesKey: 'bonefish', weightLb: i + 1 });
    }
    const res = await app.inject({ method: 'GET', url: '/leaderboard/overall' });
    const body = res.json() as { rows: unknown[] };
    expect(body.rows.length).toBe(100);
  });

  it('/leaderboard/species always returns one row per species, with the heaviest catch on top', async () => {
    const a = await registerUser(app, { displayName: 'Species A' });
    const b = await registerUser(app, { displayName: 'Species B' });

    await recordCatch(handle.db, { userId: a.id, speciesKey: 'tarpon', weightLb: 80 });
    await recordCatch(handle.db, { userId: b.id, speciesKey: 'tarpon', weightLb: 150 });
    await recordCatch(handle.db, { userId: a.id, speciesKey: 'mahi', weightLb: 20 });

    const res = await app.inject({ method: 'GET', url: '/leaderboard/species' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ speciesKey: string; top: { displayName: string; weightLb: number } | null }> };

    expect(body.rows.length).toBe(Object.keys(SPECIES).length);

    const tarpon = body.rows.find((r) => r.speciesKey === 'tarpon');
    expect(tarpon?.top?.displayName).toBe('Species B');
    expect(tarpon?.top?.weightLb).toBe(150);

    const mahi = body.rows.find((r) => r.speciesKey === 'mahi');
    expect(mahi?.top?.displayName).toBe('Species A');

    const untouched = body.rows.find((r) => r.speciesKey === 'swordfish');
    expect(untouched?.top).toBeNull();
  });
});
