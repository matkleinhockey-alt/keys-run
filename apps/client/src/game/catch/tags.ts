/**
 * Tag-and-release, client side: which tagged fish could be on the line right now, tagging a fish
 * you just landed, and reporting a recaptured one (released again or kept).
 *
 * Two backends behind one surface, picked per call by whether there is a session — the same split
 * as ui/leaderboard/submit-catch.ts:
 *   - signed in: apps/api's shared registry (apps/api/src/routes/tags.ts), so you can hook a fish
 *     someone else tagged and see who has had it before you;
 *   - offline: a registry in this browser's localStorage, so solo play still has tags that grow
 *     and come back — just only your own.
 * Both run the same rules (packages/shared/src/sim/tagging.ts).
 *
 * The rod picks a recapture synchronously at the moment the fish is rolled (fishing/update.ts's
 * `chooseFishLocal`), so the fight is fought at the tagged fish's real weight. That can't wait on
 * a request, so `prefetch` is called on every cast and `pickRecapture` only reads its cache — a
 * cast whose fetch hasn't come back yet simply hooks an untagged fish.
 *
 * Every network failure is swallowed into "no tag" / `null`: a landed fish must never be held up
 * or broken by the registry.
 */
import {
  DAY_MS,
  RECAPTURE_COOLDOWN_MS,
  RECAPTURE_P,
  grownWeight,
  tagCode,
  wanderRadiusM,
  type TagEvent,
  type TaggedFish,
} from '@keysrun/shared/sim/tagging';
import { API_BASE_URL } from '../../net/config.js';
import { getCurrentSession } from '../../ui/auth/session.js';

export type { TaggedFish, TagEvent };

const LOCAL_KEY = 'keysrun.tags.v1';

export interface Landing { x: number; z: number; zone: string }

function daysSince(iso: string, now: number): number {
  return Math.max(0, (now - Date.parse(iso)) / DAY_MS);
}

/** Same test as the server's `catchableAt`. */
function catchableAt(f: TaggedFish, x: number, z: number, now: number): boolean {
  if (f.status !== 'at_large') return false;
  if (now - Date.parse(f.lastSeenAt) < RECAPTURE_COOLDOWN_MS) return false;
  return Math.hypot(f.x - x, f.z - z) <= wanderRadiusM(daysSince(f.lastSeenAt, now));
}

/* ------------------------------------------------------------------ offline registry */

/** Stored with `weightLb` = last in-hand weight (like the server's row); `withGrowth` turns that
 * into the weight now. */
function loadLocal(): TaggedFish[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as TaggedFish[]) : [];
  } catch { return []; }
}

function saveLocal(list: TaggedFish[]): void {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
}

function withGrowth(f: TaggedFish, now: number): TaggedFish {
  if (f.status !== 'at_large') return f;
  return { ...f, weightLb: grownWeight(f.speciesKey, f.weightLb, daysSince(f.lastSeenAt, now)) };
}

function localEvent(kind: TagEvent['kind'], weightLb: number, at: Landing, now: number): TagEvent {
  return { kind, displayName: 'You', weightLb, zone: at.zone, x: at.x, z: at.z, at: new Date(now).toISOString() };
}

/* ------------------------------------------------------------------ remote registry */

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, init);
    return res.ok ? ((await res.json()) as T) : null;
  } catch { return null; }
}

function authed(body: unknown): RequestInit {
  const session = getCurrentSession();
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.token ?? ''}` },
    body: JSON.stringify(body),
  };
}

/* ------------------------------------------------------------------ public surface */

export function createTagRegistry() {
  /** At-large tagged fish around the last cast, with current (grown) weights. */
  let nearby: TaggedFish[] = [];
  let fetchSeq = 0;

  /** Refreshes `nearby` for a cast landing at (x, z). Fire-and-forget. */
  function prefetch(x: number, z: number): void {
    const now = Date.now();
    if (!getCurrentSession()) {
      nearby = loadLocal().filter((f) => catchableAt(f, x, z, now)).map((f) => withGrowth(f, now));
      return;
    }
    const seq = ++fetchSeq;
    void api<{ fish: TaggedFish[] }>(`/tags/nearby?x=${x.toFixed(1)}&z=${z.toFixed(1)}`).then((r) => {
      if (seq === fetchSeq) nearby = r?.fish ?? [];
    });
  }

  /** Called the moment a fish of `key` is rolled at (x, z): is it a tagged fish? Takes it out of
   * the cache either way so one cast can't roll the same tag twice. */
  function pickRecapture(key: string, x: number, z: number, rng: () => number): TaggedFish | null {
    const now = Date.now();
    const candidates = nearby.filter((f) => f.speciesKey === key && catchableAt(f, x, z, now));
    if (!candidates.length || rng() >= RECAPTURE_P) return null;
    candidates.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const pick = candidates[0];
    nearby = nearby.filter((f) => f.id !== pick.id);
    return pick;
  }

  /** Puts a tag in a fish you just landed and lets it go. */
  async function tagAndRelease(speciesKey: string, weightLb: number, at: Landing): Promise<TaggedFish | null> {
    if (getCurrentSession()) {
      return api<TaggedFish>('/tags', authed({ speciesKey, weightLb, x: at.x, z: at.z, zone: at.zone }));
    }
    const now = Date.now();
    const list = loadLocal();
    const tagNo = list.reduce((n, f) => Math.max(n, Number(f.code.slice(3)) || 0), 0) + 1;
    const fish: TaggedFish = {
      id: `local-${tagNo}`, code: tagCode(tagNo), speciesKey, weightLb: +weightLb.toFixed(2),
      x: at.x, z: at.z, status: 'at_large', lastSeenAt: new Date(now).toISOString(),
      events: [localEvent('tagged', +weightLb.toFixed(2), at, now)],
    };
    list.push(fish);
    saveLocal(list);
    return fish;
  }

  /** Reports landing an already-tagged fish. `kept` retires the tag. */
  async function reportLanded(tag: TaggedFish, at: Landing, kept: boolean): Promise<TaggedFish | null> {
    if (getCurrentSession() && !tag.id.startsWith('local-')) {
      return api<TaggedFish>(`/tags/${encodeURIComponent(tag.id)}/landed`, authed({ x: at.x, z: at.z, zone: at.zone, kept }));
    }
    const now = Date.now();
    const list = loadLocal();
    const i = list.findIndex((f) => f.id === tag.id);
    if (i < 0) return null;
    const w = withGrowth(list[i], now).weightLb;
    list[i] = {
      ...list[i], weightLb: w, x: at.x, z: at.z, lastSeenAt: new Date(now).toISOString(),
      status: kept ? 'harvested' : 'at_large',
      events: [...list[i].events, localEvent(kept ? 'harvested' : 'released', w, at, now)],
    };
    saveLocal(list);
    return list[i];
  }

  return { prefetch, pickRecapture, tagAndRelease, reportLanded };
}

export type TagRegistry = ReturnType<typeof createTagRegistry>;

/** "3 days ago" / "5 hours ago" / "just now". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  const units: Array<[number, string]> = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, name] of units) {
    if (s >= n) { const v = Math.floor(s / n); return `${v} ${name}${v === 1 ? '' : 's'} ago`; }
  }
  return 'just now';
}

/** The catch card's history block for a recaptured fish: who tagged it, who has had it since,
 * and how it has grown. */
export function describeTag(tag: TaggedFish): { headline: string; lines: string[] } {
  const [first, ...rest] = tag.events;
  const caught = tag.events.length;
  const headline = `🏷 Tagged fish ${tag.code} · landed ${caught} time${caught === 1 ? '' : 's'} before you`;
  const lines: string[] = [];
  if (first) lines.push(`Tagged by ${first.displayName} ${ago(first.at)} at ${first.weightLb.toFixed(1)} lb`);
  for (const e of rest.slice(-3)) lines.push(`Caught by ${e.displayName} ${ago(e.at)} at ${e.weightLb.toFixed(1)} lb`);
  if (rest.length > 3) lines.splice(1, 0, `…${rest.length - 3} earlier recapture${rest.length - 3 === 1 ? '' : 's'}`);
  const last = tag.events[tag.events.length - 1];
  if (last) {
    const gain = tag.weightLb - last.weightLb;
    lines.push(gain >= 0.05 ? `Grown ${gain.toFixed(1)} lb since it was last in hand` : 'Hasn’t had time to grow since it was last in hand');
  }
  return { headline, lines };
}
