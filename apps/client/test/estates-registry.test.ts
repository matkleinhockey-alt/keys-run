/**
 * The offline estates registry (game/estates/registry.ts with no session): buying from the wallet,
 * the refusals that must not cost money, building, and the solo party.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LOTS_PER_PLAYER, PARCELS, priceOf } from '@keysrun/shared/content/estates';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
vi.mock('../src/ui/auth/session.js', () => ({ getCurrentSession: () => null }));
vi.mock('../src/net/config.js', () => ({ API_BASE_URL: 'http://api.invalid' }));

const { createEstateRegistry } = await import('../src/game/estates/registry.js');

function wallet(cash: number) {
  return { cash: () => cash, debit(n: number) { if (n > cash) return false; cash -= n; return true; }, credit(n: number) { cash += n; } };
}

const lots = PARCELS.filter((p) => p.tier === 'bayfront');

describe('offline estates registry', () => {
  beforeEach(() => { store.clear(); });

  it('starts with only the founding lots, and refuses to sell one', async () => {
    const reg = createEstateRegistry();
    expect(reg.registry.estates.every((e) => e.founding)).toBe(true);
    const w = wallet(1e6);
    expect((await reg.buy('pigeon-key', w)).ok).toBe(false);
    expect(w.cash()).toBe(1e6);
  });

  it('charges the table price, remembers the lot across a reload, and will not sell it twice', async () => {
    const w = wallet(100000);
    const reg = createEstateRegistry();
    const r = await reg.buy(lots[0].id, w);
    expect(r.ok).toBe(true);
    expect(w.cash()).toBe(100000 - priceOf(lots[0]));
    expect((await reg.buy(lots[0].id, w)).message).toMatch(/already yours/);
    expect(w.cash()).toBe(100000 - priceOf(lots[0]));

    const again = createEstateRegistry();
    expect(again.mine().map((e) => e.parcelId)).toEqual([lots[0].id]);
  });

  it('takes nothing when you cannot afford it or already hold the most lots', async () => {
    const reg = createEstateRegistry();
    const poor = wallet(10);
    expect((await reg.buy(lots[0].id, poor)).message).toMatch(/more for/);
    expect(poor.cash()).toBe(10);

    const rich = wallet(1e7);
    for (let i = 0; i < MAX_LOTS_PER_PLAYER; i++) expect((await reg.buy(lots[i].id, rich)).ok).toBe(true);
    const before = rich.cash();
    expect((await reg.buy(lots[MAX_LOTS_PER_PLAYER].id, rich)).ok).toBe(false);
    expect(rich.cash()).toBe(before);
  });

  it('saves a cleaned build, and throws the party at your best lot once you have landed a fish', async () => {
    const reg = createEstateRegistry();
    const w = wallet(1e7);
    const cheap = [...lots].sort((a, b) => priceOf(a) - priceOf(b));
    await reg.buy(cheap[0].id, w);
    await reg.buy(cheap[cheap.length - 1].id, w);
    expect(await reg.saveBuild(cheap[0].id, { res: 'shack', trophies: 99 })).toBe(true);
    expect(reg.owner(cheap[0].id)?.build).toMatchObject({ res: 'shack', trophies: 10 });
    expect(await reg.saveBuild('pigeon-key', { res: 'shack' })).toBe(false);

    expect(reg.registry.party).toBeNull();
    reg.noteCatch('tarpon', 90);
    expect(reg.registry.party).toMatchObject({ parcelId: cheap[cheap.length - 1].id, displayName: 'You', speciesKey: 'tarpon', weightLb: 90 });
    reg.noteCatch('bonefish', 5); // smaller: the party keeps the bigger fish
    expect(reg.registry.party?.speciesKey).toBe('tarpon');
  });
});
