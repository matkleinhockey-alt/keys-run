/**
 * Reads for the live leaderboard — apps/api's three read-only leaderboard endpoints
 * (apps/api/src/routes/leaderboard.ts, players.ts). These are public (no auth) and, per
 * docs/ARCHITECTURE.md's authority model, backed entirely by server-written rows: "There is no
 * client->server 'I caught X' message anywhere in the protocol" — this module only ever reads.
 */
import { API_BASE_URL } from '../../net/config.js';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`leaderboard fetch failed: ${path} (${res.status})`);
  return (await res.json()) as T;
}

export interface OverallRow {
  rank: number;
  userId: string;
  displayName: string;
  speciesKey: string;
  weightLb: number;
  catchCount: number;
}

export function fetchOverall(): Promise<{ rows: OverallRow[] }> {
  return getJson('/leaderboard/overall');
}

export interface SpeciesRow {
  speciesKey: string;
  top: { userId: string; displayName: string; weightLb: number; caughtAt: string } | null;
}

export function fetchSpecies(): Promise<{ rows: SpeciesRow[] }> {
  return getJson('/leaderboard/species');
}

export interface PlayerRecords {
  best: { key: string; weight: number } | null;
  sp: Record<string, number>;
  count: number;
}

export function fetchPlayerRecords(userId: string): Promise<PlayerRecords> {
  return getJson(`/players/${encodeURIComponent(userId)}/records`);
}
