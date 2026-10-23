import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MAX_LOTS_PER_PLAYER, PARCELS, parcelById, priceOf, type Estate, type Registry } from '@keysrun/shared/content/estates';
import type { DbHandle } from '../db/client.js';
import { buildTestApp, registerUser, loginUser, testDbHandle, truncateAll } from './helpers.js';

describe('estates registry', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(() => { handle = testDbHandle(); });
  afterAll(async () => { await handle.close(); });
  beforeEach(async () => { await truncateAll(handle); app = await buildTestApp(handle); });
  afterEach(async () => { await app.close(); });

  async function angler(displayName: string): Promise<string> {
    const user = await registerUser(app, { displayName });
    return (await loginUser(app, user.email, user.password)).token;
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const buy = (t: string, id: string) => app.inject({ method: 'POST', url: `/estates/${id}/buy`, headers: auth(t) });
  const build = (t: string, id: string, b: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/estates/${id}/build`, headers: auth(t), payload: { build: b } });
  const registry = async () => (await app.inject({ method: 'GET', url: '/estates' })).json() as Registry;

  const forSale = PARCELS.filter((p) => p.tier === 'oceanfront');

  it('lists the founding lots before anyone has bought anything', async () => {
    const reg = await registry();
    expect(reg.estates.map((e) => e.parcelId).sort()).toEqual(['fisher-island', 'harbor-row-1', 'harbor-row-4', 'pigeon-key']);
    expect(reg.estates.every((e) => e.founding)).toBe(true);
    expect(reg.party).toBeNull();
  });

  it('sells a lot once, at the table price, and lets only its owner build', async () => {
    const alice = await angler('Alice');
    const bob = await angler('Bob');
    const lot = forSale[0];

    const res = await buy(alice, lot.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: priceOf(lot), estate: { parcelId: lot.id, ownerName: 'Alice', founding: false } });

    expect((await buy(bob, lot.id)).statusCode).toBe(409);
    expect((await build(bob, lot.id, { res: 'shack' })).statusCode).toBe(403);

    const saved = await build(alice, lot.id, { res: 'stilt', dock: 'yacht', fish: 'kraken', trophies: 99 });
    expect(saved.statusCode).toBe(200);
    const e = (saved.json() as { estate: Estate }).estate;
    expect(e.build).toMatchObject({ res: 'stilt', dock: 'yacht', trophies: 10 });
    expect(e.build.fish).not.toBe('kraken');

    expect((await registry()).estates.find((x) => x.parcelId === lot.id)?.build.res).toBe('stilt');
  });

  it('never sells a founding lot, and lets the founder (by name) build on it', async () => {
    const larry = await angler('larry');
    const bob = await angler('Bob');
    expect((await buy(bob, 'fisher-island')).statusCode).toBe(409);
    expect((await build(bob, 'fisher-island', { res: 'shack' })).statusCode).toBe(403);
    const res = await build(larry, 'fisher-island', { res: 'shack' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { estate: Estate }).estate).toMatchObject({ ownerName: 'larry', founding: true, build: { res: 'shack' } });
    expect((await registry()).estates.filter((e) => e.parcelId === 'fisher-island')).toHaveLength(1);
  });

  it('caps how many lots one angler holds, and 404s an unknown lot', async () => {
    const alice = await angler('Alice');
    for (let i = 0; i < MAX_LOTS_PER_PLAYER; i++) expect((await buy(alice, forSale[i].id)).statusCode).toBe(200);
    const over = await buy(alice, forSale[MAX_LOTS_PER_PLAYER].id);
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: 'lot_limit' });
    expect((await buy(alice, 'atlantis')).statusCode).toBe(404);
  });

  it('throws the party at the #1 angler\'s most valuable lot', async () => {
    const alice = await angler('Alice');
    const bob = await angler('Bob');
    const cheap = [...forSale].sort((a, b) => priceOf(a) - priceOf(b));
    await buy(alice, cheap[0].id);
    await buy(alice, cheap[cheap.length - 1].id);
    await buy(bob, cheap[1].id);
    await app.inject({ method: 'POST', url: '/catches', headers: auth(bob), payload: { speciesKey: 'tarpon', weightLb: 90 } });
    expect((await registry()).party).toMatchObject({ displayName: 'Bob', parcelId: cheap[1].id, speciesKey: 'tarpon', weightLb: 90 });

    await app.inject({ method: 'POST', url: '/catches', headers: auth(alice), payload: { speciesKey: 'tarpon', weightLb: 120 } });
    const party = (await registry()).party!;
    expect(party.displayName).toBe('Alice');
    expect(party.parcelId).toBe(cheap[cheap.length - 1].id);
    expect(parcelById(party.parcelId)).toBeDefined();
  });
});
