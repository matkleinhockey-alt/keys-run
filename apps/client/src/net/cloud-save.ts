/**
 * Where the player's game lives. Signed in, it is the account's save on the server
 * (apps/api/src/routes/save.ts, the `player_saves` table); signed out, it is this browser's
 * localStorage, as it always was.
 *
 * Every system that keeps state (the wallet, inventory, casino, services, treasure, charted wrecks)
 * loads and saves it through `readSave` / `writeSave` here instead of touching localStorage. After
 * the auth gate, `hydrate` fetches the account's save and from then on those calls work on that copy
 * in memory, uploading each change within SYNC_DELAY_MS. While an account is playing, nothing of its
 * game is written to the browser: the offline game in localStorage is left as it was, and signing
 * out goes back to it.
 *
 * Recovering progress: the first time an account signs in on a browser, that browser's offline game
 * (or what the first cloud-save build left there) is weighed against the account's save, and the one
 * further along wins (`further`). Only the first account to sign in on a browser can take its
 * offline game, so two accounts never both inherit it.
 */
import { API_BASE_URL } from './config.js';
import type { Session } from '../ui/auth/session.js';

/** Everything that is the player's game. Not the session, settings, or what the server already
 * keeps per account when signed in (estates, tags). */
export const CLOUD_KEYS = [
  'keysrun.economy.v1',
  'keysrun.inventory.v1',
  'keysrun.casino.v1',
  'keysrun.services.v1',
  'keysrun.treasure.v1',
  'keysrun.wrecks.charted.v1',
] as const;

/** Which account took this browser's offline game. */
const CLAIM_KEY = 'keysrun.offline-claimed.v1';
/** Left by the first cloud-save build, which kept the account's game in localStorage. */
const LEGACY_MARK_KEY = 'keysrun.cloud.v1';
const LEGACY_BACKUP_KEY = 'keysrun.offline-backup.v1';
const SYNC_DELAY_MS = 2000;
const RETRY_MS = 10_000;
const TIMEOUT_MS = 6000;

/** A game: save key -> the JSON string the system stored. */
type Save = Record<string, string>;

function get(k: string): string | null { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } }
function set(k: string, v: string): void { try { globalThis.localStorage?.setItem(k, v); } catch { /* unremembered */ } }
function del(k: string): void { try { globalThis.localStorage?.removeItem(k); } catch { /* ignore */ } }

/** The account's game while one is signed in; null plays the browser's offline game. */
let live: Map<string, string> | null = null;
let account: Session | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

/** What a system saved under `key`, or null for a new player. */
export function readSave(key: string): string | null {
  return live ? live.get(key) ?? null : get(key);
}

/** Saves a system's state: to the account when signed in, else to this browser. */
export function writeSave(key: string, json: string): void {
  if (!live) { set(key, json); return; }
  if (live.get(key) === json) return;
  live.set(key, json);
  changed();
}

export function removeSave(key: string): void {
  if (!live) { del(key); return; }
  if (live.delete(key)) changed();
}

function offlineGame(): Save {
  const out: Save = {};
  for (const k of CLOUD_KEYS) { const v = get(k); if (v !== null) out[k] = v; }
  return out;
}

/** Wire format: each value as JSON, so the database row reads like the game. */
function toWire(s: Save): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) { try { out[k] = JSON.parse(v); } catch { /* corrupt: dropped */ } }
  return out;
}
function fromWire(d: Record<string, unknown>): Save {
  const out: Save = {};
  // the first build stored the JSON strings themselves
  for (const k of CLOUD_KEYS) if (k in d) out[k] = typeof d[k] === 'string' ? d[k] : JSON.stringify(d[k]);
  return out;
}

/** How far along a game is: lifetime earnings (which never go down), then cash. */
function progress(s: Save): [number, number] {
  try {
    const e = JSON.parse(s['keysrun.economy.v1'] ?? '{}') as { earned?: unknown; cash?: unknown };
    return [Number(e.earned) || 0, Number(e.cash) || 0];
  } catch { return [0, 0]; }
}
/** True if `a` is strictly further along than `b`. */
export function further(a: Save, b: Save): boolean {
  const [ea, ca] = progress(a), [eb, cb] = progress(b);
  return ea !== eb ? ea > eb : ca > cb;
}

async function call(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      ...init, signal: init.keepalive ? undefined : ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
  } finally { clearTimeout(t); }
}

async function upload(keepalive = false): Promise<boolean> {
  if (!live || !account) return true;
  dirty = false;
  try {
    const res = await call('/save', account.token, { method: 'PUT', body: JSON.stringify({ data: toWire(Object.fromEntries(live)) }), keepalive });
    if (!res.ok) throw new Error(String(res.status));
    return true;
  } catch {
    dirty = true;
    schedule(RETRY_MS);
    return false;
  }
}

function schedule(ms: number): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) void upload(); }, ms);
}
function changed(): void { dirty = true; schedule(SYNC_DELAY_MS); }

export type HydrateResult = 'server' | 'recovered' | 'new' | 'unreachable';

/** After sign-in, before the world is built: makes the account's save the game every system loads.
 * 'unreachable' leaves the browser's offline game in play, unsaved to the account. */
export async function hydrate(session: Session): Promise<HydrateResult> {
  let remote: Save | null;
  try {
    const res = await call('/save', session.token);
    if (!res.ok) return 'unreachable';
    const d = ((await res.json()) as { data: Record<string, unknown> | null }).data;
    remote = d ? fromWire(d) : null;
  } catch { return 'unreachable'; }

  // The first cloud-save build kept the signed-in account's game in localStorage and the offline
  // game in a backup. Put the offline game back where it belongs, keeping the account's copy as a
  // candidate if it is this account's (it may hold changes that never reached the server).
  let legacy: Save | null = null;
  const markRaw = get(LEGACY_MARK_KEY);
  if (markRaw !== null) {
    let mark: { userId?: unknown } | null = null;
    try { mark = JSON.parse(markRaw) as { userId?: unknown }; } catch { /* corrupt */ }
    if (mark?.userId === session.userId) legacy = offlineGame();
    let backup: Save = {};
    try { backup = JSON.parse(get(LEGACY_BACKUP_KEY) ?? '{}') as Save; } catch { /* fresh offline game */ }
    for (const k of CLOUD_KEYS) { if (typeof backup[k] === 'string') set(k, backup[k]); else del(k); }
    del(LEGACY_BACKUP_KEY);
    del(LEGACY_MARK_KEY);
  }

  let game: Save = remote ?? {};
  let result: HydrateResult = remote ? 'server' : 'new';
  if (legacy && !further(game, legacy)) game = legacy; // newer, unless the server is further along
  const claimedBy = get(CLAIM_KEY);
  if (claimedBy === null || claimedBy === session.userId) {
    const offline = offlineGame();
    if (Object.keys(offline).length > 0) {
      set(CLAIM_KEY, session.userId);
      if (!remote || further(offline, game)) { game = offline; result = 'recovered'; }
    }
  }

  live = new Map(Object.entries(game));
  account = session;
  if (game !== remote) await upload();
  if (!listening) {
    listening = true;
    globalThis.addEventListener?.('pagehide', flushNow);
    globalThis.document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
  }
  return result;
}

function flushNow(): void { if (dirty) void upload(true); }

/** Before signing out: the last changes up to the account, then back to the offline game. */
export async function signOutSave(): Promise<void> {
  if (dirty) await upload();
  live = null;
  account = null;
}
