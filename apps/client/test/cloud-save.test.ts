/**
 * net/cloud-save.ts against a fake /save: which game ends up in the browser after a sign-in, and
 * what signing out puts back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
vi.mock('../src/net/config.js', () => ({ API_BASE_URL: 'http://api.test' }));

/** The server: one save per bearer token. */
const server = new Map<string, Record<string, string>>();
vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
  const token = (init.headers as Record<string, string>).Authorization.replace('Bearer ', '');
  if (!url.endsWith('/save')) return new Response(null, { status: 404 });
  if (init.method === 'PUT') { server.set(token, (JSON.parse(init.body as string) as { data: Record<string, string> }).data); return Response.json({ updatedAt: 'now' }); }
  return Response.json({ data: server.get(token) ?? null, updatedAt: null });
});

const { hydrate, signOutSave } = await import('../src/net/cloud-save.js');

const ECON = 'keysrun.economy.v1';
const klein = { token: 'tk', userId: 'u-klein', displayName: 'Klein' };
const larry = { token: 'tl', userId: 'u-larry', displayName: 'Larry' };
const cash = () => JSON.parse(store.get(ECON) ?? '{"cash":0}').cash as number;

describe('cloud save', () => {
  beforeEach(() => { store.clear(); server.clear(); });

  it('claims this browser\'s offline game for a brand-new account, and gives it back on sign-out', async () => {
    store.set(ECON, '{"cash":500}');
    expect(await hydrate(klein)).toBe('claimed');
    expect(server.get('tk')).toEqual({ [ECON]: '{"cash":500}' });
    store.set(ECON, '{"cash":900}'); // played signed in
    await signOutSave(klein);
    expect(server.get('tk')![ECON]).toBe('{"cash":900}');
    expect(cash()).toBe(500); // the offline game, as it was
  });

  it('loads the account\'s game over offline progress, which it keeps aside', async () => {
    server.set('tk', { [ECON]: '{"cash":7000}' });
    store.set(ECON, '{"cash":5}');
    expect(await hydrate(klein)).toBe('server');
    expect(cash()).toBe(7000);
    await signOutSave(klein);
    expect(cash()).toBe(5);
  });

  it('uploads changes the account\'s game made after its last sync, rather than losing them', async () => {
    server.set('tk', { [ECON]: '{"cash":100}' });
    await hydrate(klein);
    store.set(ECON, '{"cash":150}'); // the tab closed before the next sync
    expect(await hydrate(klein)).toBe('local');
    expect(server.get('tk')![ECON]).toBe('{"cash":150}');
  });

  it('never hands one account\'s game to another', async () => {
    server.set('tk', { [ECON]: '{"cash":100}' });
    await hydrate(klein);
    expect(await hydrate(larry)).toBe('fresh');
    expect(store.has(ECON)).toBe(false);
    expect(server.get('tk')![ECON]).toBe('{"cash":100}');
  });
});
