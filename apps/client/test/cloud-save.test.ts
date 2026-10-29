/**
 * net/cloud-save.ts against a fake /save: signed in, the game lives in the account's save and not
 * in the browser; the first sign-in on a browser recovers its offline progress if that is further
 * along; and one account's game never reaches another.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
vi.mock('../src/net/config.js', () => ({ API_BASE_URL: 'http://api.test' }));

/** The server: one save per bearer token, as the JSON it was sent. */
const server = new Map<string, Record<string, unknown>>();
vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
  const token = (init.headers as Record<string, string>).Authorization.replace('Bearer ', '');
  if (!url.endsWith('/save')) return new Response(null, { status: 404 });
  if (init.method === 'PUT') { server.set(token, (JSON.parse(init.body as string) as { data: Record<string, unknown> }).data); return Response.json({ updatedAt: 'now' }); }
  return Response.json({ data: server.get(token) ?? null, updatedAt: null });
});

const { hydrate, signOutSave, readSave, writeSave } = await import('../src/net/cloud-save.js');

const ECON = 'keysrun.economy.v1';
const klein = { token: 'tk', userId: 'u-klein', displayName: 'Klein' };
const larry = { token: 'tl', userId: 'u-larry', displayName: 'Larry' };
const econ = (cash: number, earned = cash) => JSON.stringify({ v: 1, cash, earned });
const cash = () => (JSON.parse(readSave(ECON) ?? '{"cash":0}') as { cash: number }).cash;
const serverCash = (t: string) => (server.get(t)?.[ECON] as { cash: number } | undefined)?.cash;

describe('cloud save', () => {
  beforeEach(async () => { await signOutSave(); store.clear(); server.clear(); });

  it('keeps the signed-in game in the account, not the browser', async () => {
    server.set('tk', { [ECON]: { v: 1, cash: 7000, earned: 9000 } });
    store.set(ECON, econ(5));
    expect(await hydrate(klein)).toBe('server');
    expect(cash()).toBe(7000);
    writeSave(ECON, econ(7500, 9500));
    await signOutSave(); // uploads what is pending
    expect(serverCash('tk')).toBe(7500);
    expect(JSON.parse(store.get(ECON)!).cash).toBe(5); // the browser never saw the account's money
    expect(cash()).toBe(5); // signed out: the offline game
  });

  it('recovers this browser\'s offline progress into the account when it is further along', async () => {
    server.set('tk', { [ECON]: { v: 1, cash: 0, earned: 0 } }); // registered elsewhere, empty
    store.set(ECON, econ(400_000, 650_000));
    expect(await hydrate(klein)).toBe('recovered');
    expect(cash()).toBe(400_000);
    expect(serverCash('tk')).toBe(400_000);
  });

  it('does not let older offline progress overwrite the account', async () => {
    server.set('tk', { [ECON]: { v: 1, cash: 50, earned: 90_000 } });
    store.set(ECON, econ(80_000, 80_000));
    expect(await hydrate(klein)).toBe('server');
    expect(cash()).toBe(50);
  });

  it('lets only the first account on a browser take its offline game', async () => {
    store.set(ECON, econ(1000));
    await hydrate(klein);
    expect(serverCash('tk')).toBe(1000);
    await signOutSave();
    expect(await hydrate(larry)).toBe('new');
    expect(cash()).toBe(0);
    expect(serverCash('tl')).toBeUndefined();
  });

  it('reads saves from the first build, which held JSON strings', async () => {
    server.set('tk', { [ECON]: econ(321) });
    store.set('keysrun.offline-claimed.v1', 'u-someone');
    await hydrate(klein);
    expect(cash()).toBe(321);
  });

  it('moves the first build\'s layout back: account copy up, offline game back in place', async () => {
    // the first build: the account's game in localStorage, the offline game in a backup
    server.set('tk', { [ECON]: econ(100) });
    store.set(ECON, econ(150, 150)); // changes that never reached the server
    store.set('keysrun.cloud.v1', JSON.stringify({ userId: 'u-klein', synced: '' }));
    store.set('keysrun.offline-backup.v1', JSON.stringify({ [ECON]: econ(5) }));
    await hydrate(klein);
    expect(cash()).toBe(150);
    expect(serverCash('tk')).toBe(150);
    expect(JSON.parse(store.get(ECON)!).cash).toBe(5);
    expect(store.has('keysrun.cloud.v1')).toBe(false);
  });
});
