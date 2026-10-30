/**
 * The client half of the ocean ledger (apps/api/src/routes/ocean.ts): how hard each patch of water
 * has been fished, and what that does to the next fish hooked there.
 *
 * Before this, the pure model (shared/sim/ocean.ts) had no inputs. Nothing knew a spot had been
 * worked, so the thousandth snapper from one reef was the same size as the first. This keeps one
 * number per fish chunk (64 x 64 world units, the server's cell) and answers `recoveryAt(x, z)`,
 * the 0..1 the weight roll takes (1 = untouched = today's fish).
 *
 * OFFLINE IS THE GAME, NOT A FALLBACK. Signed out, or signed in with the API down, every cell is
 * pristine: `recoveryAt` is 1, the weight roll is skipped entirely (not multiplied by 1.0), no
 * request is made, nothing is stored, nothing throws. A signed-out player does not even READ other
 * players' pressure, though the GET is public, because that would change the offline game. The
 * ledger is an account feature that is simply absent otherwise.
 *
 * NEVER ON THE RENDER LOOP. `recoveryAt` and `update` are synchronous map lookups; the network
 * only ever runs in a detached promise that nothing awaits. A cell we have not heard about yet is
 * pristine for now (the first cast into brand-new water can be a full-size fish; the alternative
 * is making the hookset wait on a request).
 *
 * REQUEST BUDGET (asserted in test/ocean-net.test.ts against a fake server; a 100-chunk run at
 * 25 units/s measured 62 GETs, 476 cells, largest batch 49; 1,000 boundary crossings, 0 more):
 *   - Window: the 7 x 7 chunks around the boat (192 units each way), well past any cast. One GET
 *     carries only the cells we do not hold, never the whole window: crossing one chunk boundary
 *     asks for the 7 cells of the new edge. 49 is far under the route's 256 cap.
 *   - Cache: every answered cell is held, including the ones the server omitted (pristine), so
 *     "nobody has fished here" is not asked again until TTL_MS (5 min) passes. Refetching on TTL
 *     is how another angler's fishing reaches you without a push channel.
 *   - Position only matters when the boat changes chunk, or every CHECK_MS for stale cells, so a
 *     frame in the middle of a chunk costs two compares. Hovering on a boundary is all cache hits.
 *   - One GET in flight and at least MIN_GAP_MS between them, so a fast boat's several crossings
 *     coalesce into one request. A failure backs off 2 s, 4 s ... 60 s; success resets it.
 *
 * YOUR OWN CATCHES count at once, locally, so the next fish is already smaller before the POST
 * returns (or at all, if it fails). A cell holding an unconfirmed local catch is not overwritten
 * by a GET (which could predate it); the POST's answer is authoritative and clears the flag.
 * Catches the server has not acknowledged are kept and re-sent with backoff, so a signed-in
 * session that loses the API for ten minutes still reports its fishing afterwards.
 *
 * Style and failure policy follow net/cloud-save.ts: a timeout on every call, silent on every
 * failure, retry with a delay, session read lazily from ui/auth/session.ts.
 */
import { WB } from '@keysrun/shared/world/depth';
import { pressureAfterCatch, recovery, PRESSURE_CAP } from '@keysrun/shared/sim/ocean';
import { API_BASE_URL } from './config.js';
import { getCurrentSession, type Session } from '../ui/auth/session.js';

/** Must match CHUNK_SIZE in entities/fish/spawn.ts and apps/api/src/routes/ocean.ts. */
export const CELL_SIZE = 64;
/** Chunks held on each side of the boat's: a 7 x 7 window. */
export const WINDOW_RADIUS = 3;
/** The route's cap per GET. */
export const MAX_BATCH = 256;
/** How long an answer (including "pristine") is trusted before it is asked for again. */
export const TTL_MS = 5 * 60_000;
/** Shortest gap between two GETs, so a fast boat's several crossings coalesce into one request. */
export const MIN_GAP_MS = 1500;
const CHECK_MS = 30_000;
const TIMEOUT_MS = 6000;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
/** Cells held at most; oldest-fetched go first. 49 are live, so this only bounds a long voyage. */
const CACHE_MAX = 1500;
const HOUR_MS = 3_600_000;

/** The server's CELL_BOUNDS: a GET naming one cell outside the world is rejected whole (400), so
 * the window near the edge of the map must be trimmed or it would fail forever. */
const BOUNDS = {
  cx0: Math.floor(WB.x0 / CELL_SIZE), cx1: Math.floor(WB.x1 / CELL_SIZE),
  cz0: Math.floor(WB.z0 / CELL_SIZE), cz1: Math.floor(WB.z1 / CELL_SIZE),
};
const inWorld = (cx: number, cz: number): boolean =>
  cx >= BOUNDS.cx0 && cx <= BOUNDS.cx1 && cz >= BOUNDS.cz0 && cz <= BOUNDS.cz1;

interface Cell {
  /** Pressure as of `lastMs` (undecayed; `recovery` does the resting). */
  pressure: number;
  lastMs: number;
  fetchedMs: number;
  /** Holds a catch the server has not confirmed; a GET must not overwrite it. */
  local: boolean;
}

export interface OceanEnv {
  session(): Session | null;
  fetch: typeof fetch;
  now(): number;
  baseUrl: string;
}

export interface OceanLedger {
  /** 0..1 for the water at (x, z); exactly 1 when untouched, unknown, signed out or offline. */
  recoveryAt(x: number, z: number): number;
  /** Call as the boat moves (cheap; fine every frame). Starts a background fetch when needed. */
  update(x: number, z: number): void;
  /** A fish was landed at (x, z). */
  recordCatch(x: number, z: number): void;
  /** Requests started, for the tests. */
  stats(): { gets: number; posts: number; cached: number };
}

const cellOf = (v: number): number => Math.floor(v / CELL_SIZE);
const keyOf = (cx: number, cz: number): string => `${cx},${cz}`;

export function createOceanLedger(env: OceanEnv): OceanLedger {
  const cache = new Map<string, Cell>();
  /** Catches not yet acknowledged, by cell. */
  const owed = new Map<string, { cx: number; cz: number; amount: number }>();
  let user: string | null = null;
  let lastCx = NaN, lastCz = NaN;
  let nextCheck = 0, gapUntil = 0;
  let getBusy = false, postBusy = false;
  let getFails = 0, postFails = 0;
  let getBlockedUntil = 0, postBlockedUntil = 0;
  let postTimer: ReturnType<typeof setTimeout> | null = null;
  let gets = 0, posts = 0;

  /** The signed-in account, resetting everything when it changes or goes (signing out makes the
   * water pristine again, and one account's owed catches never go out under another). */
  function who(): Session | null {
    let s: Session | null = null;
    try { s = env.session(); } catch { s = null; }
    const id = s?.userId ?? null;
    if (id !== user) {
      user = id; cache.clear(); owed.clear();
      lastCx = lastCz = NaN; nextCheck = gapUntil = 0;
      getFails = postFails = 0; getBlockedUntil = postBlockedUntil = 0;
    }
    return s;
  }

  async function call(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await env.fetch(`${env.baseUrl}${path}`, {
        ...init, signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
    } finally { clearTimeout(t); }
  }

  function trim(): void {
    if (cache.size <= CACHE_MAX) return;
    const byAge = [...cache.entries()].sort((a, b) => a[1].fetchedMs - b[1].fetchedMs);
    for (const [k, c] of byAge) { if (cache.size <= CACHE_MAX * 0.8) break; if (!c.local) cache.delete(k); }
  }

  /** Cells of the window around (cx, cz) that we do not hold fresh. */
  function missing(cx: number, cz: number, now: number): { cx: number; cz: number }[] {
    const out: { cx: number; cz: number }[] = [];
    for (let dz = -WINDOW_RADIUS; dz <= WINDOW_RADIUS; dz++) {
      for (let dx = -WINDOW_RADIUS; dx <= WINDOW_RADIUS; dx++) {
        const x = cx + dx, z = cz + dz;
        if (!inWorld(x, z)) continue;
        const c = cache.get(keyOf(x, z));
        if (!c || (!c.local && now - c.fetchedMs >= TTL_MS)) out.push({ cx: x, cz: z });
      }
    }
    return out.slice(0, MAX_BATCH);
  }

  async function fetchCells(s: Session, cells: { cx: number; cz: number }[]): Promise<void> {
    getBusy = true; gets++;
    try {
      const q = cells.map((c) => `${c.cx},${c.cz}`).join(';');
      const res = await call(`/ocean?cells=${q}`, s.token);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { cells?: { cx: number; cz: number; pressure: number; lastCaughtAt: string }[] };
      if (who()?.userId !== s.userId) return; // signed out / switched while it was in flight
      const now = env.now();
      const disturbed = new Map<string, { pressure: number; lastMs: number }>();
      for (const r of Array.isArray(body.cells) ? body.cells : []) {
        const lastMs = Date.parse(r?.lastCaughtAt);
        if (!Number.isInteger(r?.cx) || !Number.isInteger(r?.cz) || !Number.isFinite(r?.pressure) || Number.isNaN(lastMs)) continue;
        disturbed.set(keyOf(r.cx, r.cz), { pressure: Math.min(PRESSURE_CAP, Math.max(0, r.pressure)), lastMs });
      }
      for (const c of cells) {
        const k = keyOf(c.cx, c.cz);
        if (cache.get(k)?.local) continue; // our own unconfirmed catch is newer than this answer
        const d = disturbed.get(k);
        cache.set(k, { pressure: d?.pressure ?? 0, lastMs: d?.lastMs ?? 0, fetchedMs: now, local: false });
      }
      trim();
      getFails = 0;
    } catch {
      getFails++;
      getBlockedUntil = env.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (getFails - 1));
    } finally { getBusy = false; }
  }

  async function flushOwed(): Promise<void> {
    if (postBusy) return;
    const s = who();
    if (!s || owed.size === 0) return;
    if (env.now() < postBlockedUntil) { armPost(postBlockedUntil - env.now()); return; }
    postBusy = true;
    try {
      for (const [k, o] of [...owed]) {
        posts++;
        const sent = o.amount;
        const res = await call('/ocean/catch', s.token, { method: 'POST', body: JSON.stringify({ cx: o.cx, cz: o.cz, amount: sent }) });
        if (!res.ok) {
          // A 4xx will never succeed (expired session, bad cell): drop it rather than retry forever.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) { owed.delete(k); continue; }
          throw new Error(String(res.status));
        }
        const r = (await res.json()) as { pressure?: number; lastCaughtAt?: string };
        if (who()?.userId !== s.userId) return;
        o.amount -= sent;
        if (o.amount > 0) continue; // another catch landed mid-request: still owed, local stays
        owed.delete(k);
        const lastMs = Date.parse(r.lastCaughtAt ?? '');
        const cur = cache.get(k);
        if (!cur) continue;
        if (Number.isFinite(r.pressure) && !Number.isNaN(lastMs)) {
          cache.set(k, { pressure: Math.min(PRESSURE_CAP, r.pressure as number), lastMs, fetchedMs: env.now(), local: false });
        } else cur.local = false;
      }
      postFails = 0;
    } catch {
      postFails++;
      postBlockedUntil = env.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (postFails - 1));
      armPost(postBlockedUntil - env.now());
    } finally { postBusy = false; }
  }

  function armPost(ms: number): void {
    if (postTimer) return;
    postTimer = setTimeout(() => { postTimer = null; void flushOwed(); }, Math.max(0, ms));
  }

  function recoveryAt(x: number, z: number): number {
    if (!who()) return 1;
    const c = cache.get(keyOf(cellOf(x), cellOf(z)));
    if (!c || c.pressure <= 0) return 1;
    const r = recovery(c.pressure, (env.now() - c.lastMs) / HOUR_MS);
    return Number.isFinite(r) ? r : 1;
  }

  function update(x: number, z: number): void {
    const s = who();
    if (!s) return;
    const cx = cellOf(x), cz = cellOf(z);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
    const now = env.now();
    if (getBusy || now < gapUntil || now < getBlockedUntil) return; // revisited next frame
    if (cx === lastCx && cz === lastCz && now < nextCheck) return;  // the common frame
    lastCx = cx; lastCz = cz;
    const cells = missing(cx, cz, now);
    if (cells.length === 0) { nextCheck = now + CHECK_MS; return; }
    // Look again right after the gap: a chunk crossed meanwhile is picked up then, in one request.
    nextCheck = gapUntil = now + MIN_GAP_MS;
    void fetchCells(s, cells);
  }

  function recordCatch(x: number, z: number): void {
    const s = who();
    if (!s) return; // offline: the game keeps no ledger at all
    const cx = cellOf(x), cz = cellOf(z);
    if (!Number.isFinite(cx) || !Number.isFinite(cz) || !inWorld(cx, cz)) return;
    const k = keyOf(cx, cz), now = env.now();
    const c = cache.get(k);
    const p = c ? pressureAfterCatch(c.pressure, (now - c.lastMs) / HOUR_MS) : 1;
    cache.set(k, { pressure: p, lastMs: now, fetchedMs: now, local: true });
    const o = owed.get(k);
    if (o) o.amount = Math.min(100, o.amount + 1); else owed.set(k, { cx, cz, amount: 1 });
    void flushOwed();
  }

  return { recoveryAt, update, recordCatch, stats: () => ({ gets, posts, cached: cache.size }) };
}

/** The game's ledger. */
export const ocean: OceanLedger = createOceanLedger({
  session: getCurrentSession,
  fetch: (...a) => globalThis.fetch(...a),
  now: () => Date.now(),
  baseUrl: API_BASE_URL,
});
