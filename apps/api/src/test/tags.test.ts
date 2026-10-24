import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DAY_MS, grownWeight, tagNoFromCode, type TaggedFish } from '@keysrun/shared/sim/tagging';
import type { DbHandle } from '../db/client.js';
import { taggedFish } from '../db/schema.js';
import { buildTestApp, registerUser, loginUser, testDbHandle, truncateAll } from './helpers.js';

describe('tag and release', () => {
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

  async function angler(displayName: string): Promise<string> {
    const user = await registerUser(app, { displayName });
    return (await loginUser(app, user.email, user.password)).token;
  }

  async function tag(token: string, body: Record<string, unknown>): Promise<TaggedFish> {
    const res = await app.inject({ method: 'POST', url: '/tags', headers: { authorization: `Bearer ${token}` }, payload: body });
    expect(res.statusCode).toBe(201);
    return res.json() as TaggedFish;
  }

  /** Moves a fish's last sighting into the past, as if `days` had gone by. */
  async function age(id: string, days: number): Promise<void> {
    await handle.db.update(taggedFish).set({ lastSeenAt: new Date(Date.now() - days * DAY_MS) }).where(eq(taggedFish.id, id));
  }

  it('tags a fish, which grows while at large and records everyone who lands it', async () => {
    const alice = await angler('Alice');
    const bob = await angler('Bob');

    const fish = await tag(alice, { speciesKey: 'tarpon', weightLb: 80, x: 100, z: -200, zone: 'Bridge' });
    expect(fish.code).toMatch(/^KR-\d{5}$/);
    expect(fish.status).toBe('at_large');
    expect(fish.events).toMatchObject([{ kind: 'tagged', displayName: 'Alice', weightLb: 80 }]);

    // Freshly released: on cooldown, so not on anyone's line yet.
    let nearby = await app.inject({ method: 'GET', url: '/tags/nearby?x=100&z=-200' });
    expect((nearby.json() as { fish: TaggedFish[] }).fish).toHaveLength(0);

    await age(fish.id, 30);
    nearby = await app.inject({ method: 'GET', url: '/tags/nearby?x=150&z=-150' });
    const [found] = (nearby.json() as { fish: TaggedFish[] }).fish;
    expect(found.id).toBe(fish.id);
    expect(found.weightLb).toBeGreaterThan(80);
    // Growth is towards this individual's own ceiling, so the expectation has to use its tag
    // number too (sim/tagging.ts's growthCeiling) rather than the species record.
    expect(found.weightLb).toBeCloseTo(grownWeight('tarpon', 80, 30, tagNoFromCode(fish.code)), 0);

    // Too far away for where a 30-day-old tag could have wandered.
    nearby = await app.inject({ method: 'GET', url: '/tags/nearby?x=5000&z=5000' });
    expect((nearby.json() as { fish: TaggedFish[] }).fish).toHaveLength(0);

    // Bob lands it and lets it go again. The server decides the weight, not the client.
    const landed = await app.inject({
      method: 'POST', url: `/tags/${fish.id}/landed`, headers: { authorization: `Bearer ${bob}` },
      payload: { x: 150, z: -150, zone: 'Bridge', kept: false, weightLb: 999 },
    });
    expect(landed.statusCode).toBe(200);
    const after = landed.json() as TaggedFish;
    expect(after.status).toBe('at_large');
    expect(after.x).toBe(150);
    expect(after.events.map((e) => [e.kind, e.displayName])).toEqual([['tagged', 'Alice'], ['released', 'Bob']]);
    expect(after.events[1].weightLb).toBeCloseTo(found.weightLb, 0);

    // Straight back on cooldown — Bob can't immediately re-report it.
    const again = await app.inject({
      method: 'POST', url: `/tags/${fish.id}/landed`, headers: { authorization: `Bearer ${bob}` },
      payload: { x: 150, z: -150, zone: 'Bridge', kept: false },
    });
    expect(again.statusCode).toBe(409);
  });

  it('retires the tag when a recaptured fish is kept', async () => {
    const alice = await angler('Alice');
    const fish = await tag(alice, { speciesKey: 'mahi', weightLb: 20, x: 0, z: 0, zone: 'Offshore' });
    await age(fish.id, 1);

    const kept = await app.inject({
      method: 'POST', url: `/tags/${fish.id}/landed`, headers: { authorization: `Bearer ${alice}` },
      payload: { x: 10, z: 10, zone: 'Offshore', kept: true },
    });
    expect(kept.statusCode).toBe(200);
    expect((kept.json() as TaggedFish).status).toBe('harvested');

    await age(fish.id, 5);
    const nearby = await app.inject({ method: 'GET', url: '/tags/nearby?x=0&z=0' });
    expect((nearby.json() as { fish: TaggedFish[] }).fish).toHaveLength(0);

    const history = await app.inject({ method: 'GET', url: `/tags/${fish.id}` });
    expect((history.json() as TaggedFish).events.map((e) => e.kind)).toEqual(['tagged', 'harvested']);
  });

  it('refuses to tag an implausible fish or tag anonymously', async () => {
    const alice = await angler('Alice');
    const bad = await app.inject({
      method: 'POST', url: '/tags', headers: { authorization: `Bearer ${alice}` },
      payload: { speciesKey: 'tarpon', weightLb: 500, x: 0, z: 0, zone: 'Bridge' },
    });
    expect(bad.statusCode).toBe(400);

    const anon = await app.inject({
      method: 'POST', url: '/tags', payload: { speciesKey: 'tarpon', weightLb: 80, x: 0, z: 0, zone: 'Bridge' },
    });
    expect(anon.statusCode).toBe(401);
  });
});
