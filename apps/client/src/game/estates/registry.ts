/**
 * Keys Run Estates, client side: who holds which lot, buying one, saving what stands on it, and
 * where the party is. The rules and geometry are packages/shared/src/content/estates.ts.
 *
 * Two backends behind one surface, picked per call by whether there is a session — the same split
 * as game/catch/tags.ts:
 *   - signed in: apps/api's shared registry (apps/api/src/routes/estates.ts), so every player sees
 *     every estate and the #1 angler's party;
 *   - offline: a registry in this browser's localStorage. You are the only angler, so you are #1
 *     as soon as you have landed anything, and the party is at your best lot.
 *
 * Paid from the local wallet: `buy` debits first and credits back if the server refuses (taken,
 * founding, over the per-player cap). Every network failure leaves the cached registry as it was.
 */
import {
  FOUNDING_HOLDERS, MAX_LOTS_PER_PLAYER, defaultBuild, parcelById, partyLot, priceOf, sanitizeBuild,
  type Build, type Estate, type Party, type Registry,
} from '@keysrun/shared/content/estates';
import { API_BASE_URL } from '../../net/config.js';
import { getCurrentSession } from '../../ui/auth/session.js';

const LOCAL_KEY = 'keysrun.estates.v1';
const OFFLINE_NAME = 'You';
/** Signed in, the registry is re-read this often so other players' new estates and a change at
 * the top of the leaderboard show up without a reload. */
const REFRESH_S = 60;

export interface Wallet { cash(): number; debit(n: number): boolean; credit(n: number): void }

interface LocalStore { estates: Estate[]; best: { key: string; lb: number } | null }

function loadLocal(): LocalStore {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<LocalStore>) : {};
    const estates = (Array.isArray(v.estates) ? v.estates : []).flatMap((e): Estate[] => {
      const p = e && typeof e.parcelId === 'string' ? parcelById(e.parcelId) : undefined;
      return p ? [{ ...e, ownerName: OFFLINE_NAME, build: sanitizeBuild(e.build, p) }] : [];
    });
    const best = v.best && typeof v.best.key === 'string' && typeof v.best.lb === 'number' ? v.best : null;
    return { estates, best };
  } catch { return { estates: [], best: null }; }
}

function saveLocal(s: LocalStore): void {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); } catch { /* storage full/blocked */ }
}

/** Offline: your lots plus the founders' (never yours offline — the founders are names on the
 * shared server), and your party if you have a lot and a fish. */
function localRegistry(s: LocalStore): Registry {
  const estates = [...s.estates];
  for (const [id, name] of Object.entries(FOUNDING_HOLDERS)) {
    const p = parcelById(id);
    if (p) estates.push({ parcelId: id, ownerName: name, founding: true, build: defaultBuild(p), boughtAt: null });
  }
  const lot = s.best ? partyLot(s.estates.map((e) => e.parcelId)) : null;
  const party: Party | null = lot && s.best ? { parcelId: lot.id, displayName: OFFLINE_NAME, speciesKey: s.best.key, weightLb: s.best.lb } : null;
  return { estates, party };
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, init);
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    let error: string | undefined;
    try { error = ((await res.json()) as { error?: string }).error; } catch { /* no body */ }
    return { ok: false, status: res.status, error };
  } catch { return { ok: false, status: 0 }; }
}

function authed(method: string, body?: unknown): RequestInit {
  const session = getCurrentSession();
  // No Content-Type without a body: Fastify answers an empty application/json body with a 400,
  // which is what every signed-in purchase (a bare POST) used to get.
  const headers: Record<string, string> = { Authorization: `Bearer ${session?.token ?? ''}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

const BUY_FAIL: Record<string, string> = {
  taken: 'Someone else just bought that lot.',
  founding_lot: 'That lot belongs to a founder. It is not for sale.',
  lot_limit: `You already hold ${MAX_LOTS_PER_PLAYER} lots, the most one angler may.`,
};

export function createEstateRegistry() {
  let current: Registry = localRegistry(loadLocal());
  let online = false;
  let sinceRefresh = 0;
  const listeners = new Set<() => void>();

  function set(next: Registry): void {
    current = next;
    listeners.forEach((f) => f());
  }

  function myName(): string { return getCurrentSession()?.displayName ?? OFFLINE_NAME; }

  function isMine(e: Estate): boolean {
    return e.ownerName.toLowerCase() === myName().toLowerCase();
  }

  /** Re-reads the registry: the server when signed in, else localStorage. Fire-and-forget safe. */
  async function refresh(): Promise<void> {
    sinceRefresh = 0;
    online = !!getCurrentSession();
    if (!online) { set(localRegistry(loadLocal())); return; }
    const r = await api<Registry>('/estates');
    if (r.ok && getCurrentSession()) {
      const estates = r.data.estates.flatMap((e) => { const p = parcelById(e.parcelId); return p ? [{ ...e, build: sanitizeBuild(e.build, p) }] : []; });
      set({ estates, party: r.data.party });
    }
  }

  /** Once per frame from world.ts: keeps the signed-in registry fresh, and notices sign-in/out. */
  function update(dt: number): void {
    sinceRefresh += dt;
    if (online !== !!getCurrentSession() || (online && sinceRefresh > REFRESH_S)) void refresh();
  }

  function owner(parcelId: string): Estate | undefined {
    return current.estates.find((e) => e.parcelId === parcelId);
  }

  async function buy(parcelId: string, wallet: Wallet): Promise<{ ok: boolean; message: string }> {
    const p = parcelById(parcelId);
    if (!p) return { ok: false, message: 'There is no such lot.' };
    const held = owner(parcelId);
    if (held) return { ok: false, message: isMine(held) ? `${p.name} is already yours.` : held.founding ? BUY_FAIL.founding_lot : BUY_FAIL.taken };
    if (current.estates.filter((e) => isMine(e) && !e.founding).length >= MAX_LOTS_PER_PLAYER) return { ok: false, message: BUY_FAIL.lot_limit };
    const price = priceOf(p);
    if (!wallet.debit(price)) return { ok: false, message: `You need $${(price - wallet.cash()).toLocaleString('en-US')} more for ${p.name}.` };

    if (getCurrentSession()) {
      const r = await api<{ estate: Estate; party: Party | null }>(`/estates/${encodeURIComponent(parcelId)}/buy`, authed('POST'));
      if (!r.ok) {
        wallet.credit(price);
        await refresh();
        return { ok: false, message: (r.error && BUY_FAIL[r.error]) || 'The land office is closed right now. Your money is back in your pocket.' };
      }
      await refresh();
      return { ok: true, message: `${p.name} is yours.` };
    }
    const s = loadLocal();
    s.estates.push({ parcelId, ownerName: OFFLINE_NAME, founding: false, build: defaultBuild(p), boughtAt: new Date().toISOString() });
    saveLocal(s);
    set(localRegistry(s));
    return { ok: true, message: `${p.name} is yours.` };
  }

  async function saveBuild(parcelId: string, raw: Partial<Build>): Promise<boolean> {
    const p = parcelById(parcelId);
    const e = owner(parcelId);
    if (!p || !e || !isMine(e)) return false;
    const build = sanitizeBuild({ ...e.build, ...raw }, p);
    // Optimistic: the plan and the world change at once; a refusal is put right by the refresh.
    set({ ...current, estates: current.estates.map((x) => (x.parcelId === parcelId ? { ...x, build } : x)) });
    if (getCurrentSession()) {
      const r = await api(`/estates/${encodeURIComponent(parcelId)}/build`, authed('PUT', { build }));
      if (!r.ok) await refresh();
      return r.ok;
    }
    const s = loadLocal();
    s.estates = s.estates.map((x) => (x.parcelId === parcelId ? { ...x, build } : x));
    saveLocal(s);
    return true;
  }

  /** Offline only: a landed fish may make you "#1" of your one-angler board. Signed in, the
   * server's leaderboard decides and the next refresh picks it up. */
  function noteCatch(key: string, lb: number): void {
    if (getCurrentSession()) { sinceRefresh = REFRESH_S - 3; return; }
    const s = loadLocal();
    if (s.best && s.best.lb >= lb) return;
    s.best = { key, lb };
    saveLocal(s);
    set(localRegistry(s));
  }

  return {
    get registry(): Registry { return current; },
    refresh, update, owner, isMine, myName, buy, saveBuild, noteCatch,
    mine: (): Estate[] => current.estates.filter(isMine),
    subscribe(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
  };
}

export type EstateRegistry = ReturnType<typeof createEstateRegistry>;
