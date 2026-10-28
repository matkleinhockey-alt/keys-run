/**
 * The signed-in player's game, kept on the server (apps/api/src/routes/save.ts) so money, boats,
 * gear and the rest follow the account instead of the browser.
 *
 * It works one level below the game: every system already loads and saves its own state as a JSON
 * string in localStorage (game/economy/system.ts, game/economy/inventory.ts, ...), so this only
 * moves those strings. `hydrate` runs after the auth gate and before the world is built, and
 * writes the account's save into localStorage so every system starts from it unchanged; `startSync`
 * then uploads whenever those keys change. Offline play is untouched.
 *
 * Which game the browser holds is recorded under MARK_KEY (the account, and the save as last
 * synced), so a sign-in can tell "this account's game with unsynced changes" (upload it) from
 * "offline progress" (back it up, and on a brand-new account's first sign-in, claim it) from
 * "someone else's account" (replace it). Signing out restores the offline game that was backed up.
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

const MARK_KEY = 'keysrun.cloud.v1';
const BACKUP_KEY = 'keysrun.offline-backup.v1';
const SYNC_S = 15;
const TIMEOUT_MS = 6000;

type Save = Record<string, string>;
interface Mark { userId: string; synced: string }

function get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* unremembered */ } }
function del(k: string): void { try { localStorage.removeItem(k); } catch { /* ignore */ } }

/** The game as it stands in this browser, in CLOUD_KEYS order so equal games serialise equally. */
function snapshot(): Save {
  const out: Save = {};
  for (const k of CLOUD_KEYS) { const v = get(k); if (v !== null) out[k] = v; }
  return out;
}
const canon = (s: Save): string => JSON.stringify(CLOUD_KEYS.filter((k) => k in s).map((k) => [k, s[k]]));

function write(s: Save): void {
  for (const k of CLOUD_KEYS) { if (typeof s[k] === 'string') set(k, s[k]); else del(k); }
}

function readMark(): Mark | null {
  try { const m = JSON.parse(get(MARK_KEY) ?? 'null') as Mark | null; return m && typeof m.userId === 'string' ? m : null; } catch { return null; }
}
function mark(userId: string, s: Save): void { set(MARK_KEY, JSON.stringify({ userId, synced: canon(s) })); }

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

async function upload(session: Session, s: Save, keepalive = false): Promise<boolean> {
  try {
    const res = await call('/save', session.token, { method: 'PUT', body: JSON.stringify({ data: s }), keepalive });
    if (res.ok) mark(session.userId, s);
    return res.ok;
  } catch { return false; }
}

export type HydrateResult = 'server' | 'claimed' | 'local' | 'fresh' | 'unreachable';

/** After sign-in, before the world is built: puts the account's game in localStorage. */
export async function hydrate(session: Session): Promise<HydrateResult> {
  let remote: Save | null;
  try {
    const res = await call('/save', session.token);
    if (!res.ok) return 'unreachable';
    remote = ((await res.json()) as { data: Save | null }).data;
  } catch { return 'unreachable'; }

  const m = readMark(), local = snapshot();
  if (m?.userId === session.userId && canon(local) !== m.synced) {
    // this account's game, changed since it was last synced (the tab closed first): it wins
    await upload(session, local);
    return 'local';
  }
  if (!m) set(BACKUP_KEY, JSON.stringify(local)); // offline progress: kept for signing out
  if (remote) { write(remote); mark(session.userId, remote); return 'server'; }
  if (!m || m.userId === session.userId) { await upload(session, local); return 'claimed'; }
  write({}); // another account's game is in this browser: this one starts fresh
  await upload(session, {});
  return 'fresh';
}

let syncing: Session | null = null;

/** Uploads the game whenever it has changed: every SYNC_S seconds and when the page is hidden. */
export function startSync(session: Session): void {
  if (syncing) return;
  syncing = session;
  const flushIfChanged = (keepalive: boolean): void => {
    const s = snapshot();
    if (canon(s) !== readMark()?.synced) void upload(session, s, keepalive);
  };
  setInterval(() => flushIfChanged(false), SYNC_S * 1000);
  addEventListener('pagehide', () => flushIfChanged(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushIfChanged(true); });
}

/** Before signing out: saves the account's game, then puts back the offline game it displaced. */
export async function signOutSave(session: Session): Promise<void> {
  const s = snapshot();
  if (canon(s) !== readMark()?.synced) await upload(session, s);
  let backup: Save = {};
  try { backup = JSON.parse(get(BACKUP_KEY) ?? '{}') as Save; } catch { /* fresh offline game */ }
  write(backup);
  del(BACKUP_KEY);
  del(MARK_KEY);
}
