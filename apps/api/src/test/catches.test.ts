import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '../db/client.js';
import { catches, auditFlags, globalRecords, speciesRecords } from '../db/schema.js';
import { buildTestApp, registerUser, loginUser, testDbHandle, truncateAll } from './helpers.js';

describe('POST /catches', () => {
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

  it('records a plausible catch and immediately shows up on both leaderboards', async () => {
    const user = await registerUser(app, { displayName: 'Happy Path' });
    const { token } = await loginUser(app, user.email, user.password);

    const res = await app.inject({
      method: 'POST',
      url: '/catches',
      headers: { authorization: `Bearer ${token}` },
      payload: { speciesKey: 'tarpon', weightLb: 90 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { catchId: string; suspicious: boolean };
    expect(body.suspicious).toBe(false);
    expect(typeof body.catchId).toBe('string');

    // The catch row itself is clean.
    const [row] = await handle.db.select().from(catches).where(eq(catches.id, body.catchId));
    expect(row.suspicion).toBe(0);
    expect(Number(row.weightLb)).toBe(90);

    // /leaderboard/overall reflects it.
    const overall = await app.inject({ method: 'GET', url: '/leaderboard/overall' });
    const overallBody = overall.json() as { rows: Array<{ userId: string; displayName: string; weightLb: number }> };
    expect(overallBody.rows.find((r) => r.userId === user.id)).toMatchObject({ displayName: 'Happy Path', weightLb: 90 });

    // /leaderboard/species reflects it.
    const species = await app.inject({ method: 'GET', url: '/leaderboard/species' });
    const speciesBody = species.json() as { rows: Array<{ speciesKey: string; top: { userId: string } | null }> };
    expect(speciesBody.rows.find((r) => r.speciesKey === 'tarpon')?.top?.userId).toBe(user.id);

    // /players/:id/records reflects it too.
    const records = await app.inject({ method: 'GET', url: `/players/${user.id}/records` });
    expect(records.json()).toEqual({ best: { key: 'tarpon', weight: 90 }, sp: { tarpon: 90 }, count: 1 });
  });

  it('flags an out-of-range weight, keeps it off both leaderboards, but still writes the ledger row and an audit flag', async () => {
    const user = await registerUser(app, { displayName: 'Too Big To Be True' });
    const { token } = await loginUser(app, user.email, user.password);

    // tarpon max is 160 lb (packages/shared/src/content/species.ts) — 500 lb is wildly outside it.
    const res = await app.inject({
      method: 'POST',
      url: '/catches',
      headers: { authorization: `Bearer ${token}` },
      payload: { speciesKey: 'tarpon', weightLb: 500 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { catchId: string; suspicious: boolean };
    expect(body.suspicious).toBe(true);

    // The row is still written — append-only ledger — with a positive suspicion score.
    const [row] = await handle.db.select().from(catches).where(eq(catches.id, body.catchId));
    expect(row.suspicion).toBeGreaterThan(0);
    expect(Number(row.weightLb)).toBe(500);

    // An audit_flags row exists, pointing at this catch.
    const flags = await handle.db.select().from(auditFlags).where(eq(auditFlags.catchId, body.catchId));
    expect(flags.length).toBe(1);
    expect(flags[0].reason).toBe('weight_out_of_range');

    // Neither denormalised record table moved.
    const [global] = await handle.db.select().from(globalRecords).where(eq(globalRecords.userId, user.id));
    expect(global).toBeUndefined();
    const [speciesRow] = await handle.db.select().from(speciesRecords).where(eq(speciesRecords.speciesKey, 'tarpon'));
    expect(speciesRow).toBeUndefined();

    // Public reads confirm it: no rank entry, no species-record top, zeroed personal record.
    const overall = await app.inject({ method: 'GET', url: '/leaderboard/overall' });
    const overallBody = overall.json() as { rows: Array<{ userId: string }> };
    expect(overallBody.rows.find((r) => r.userId === user.id)).toBeUndefined();

    const species = await app.inject({ method: 'GET', url: '/leaderboard/species' });
    const speciesBody = species.json() as { rows: Array<{ speciesKey: string; top: unknown }> };
    expect(speciesBody.rows.find((r) => r.speciesKey === 'tarpon')?.top).toBeNull();

    const records = await app.inject({ method: 'GET', url: `/players/${user.id}/records` });
    expect(records.json()).toEqual({ best: null, sp: {}, count: 0 });
  });

  it('400s on an unknown species key and writes nothing', async () => {
    const user = await registerUser(app, { displayName: 'Bad Species' });
    const { token } = await loginUser(app, user.email, user.password);

    const res = await app.inject({
      method: 'POST',
      url: '/catches',
      headers: { authorization: `Bearer ${token}` },
      payload: { speciesKey: 'not-a-real-fish', weightLb: 10 },
    });
    expect(res.statusCode).toBe(400);

    const rows = await handle.db.select().from(catches);
    expect(rows.length).toBe(0);
  });

  it('401s with no Authorization header, and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/catches',
      payload: { speciesKey: 'tarpon', weightLb: 90 },
    });
    expect(res.statusCode).toBe(401);

    const rows = await handle.db.select().from(catches);
    expect(rows.length).toBe(0);
  });

  it('401s with an invalid/garbage bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/catches',
      headers: { authorization: 'Bearer not-a-real-session-token' },
      payload: { speciesKey: 'tarpon', weightLb: 90 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s on a non-positive weight', async () => {
    const user = await registerUser(app, { displayName: 'Negative Fish' });
    const { token } = await loginUser(app, user.email, user.password);

    const res = await app.inject({
      method: 'POST',
      url: '/catches',
      headers: { authorization: `Bearer ${token}` },
      payload: { speciesKey: 'tarpon', weightLb: -5 },
    });
    expect(res.statusCode).toBe(400);
  });
});
