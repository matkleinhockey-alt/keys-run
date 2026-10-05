/**
 * Live leaderboard UI, replacing the `LB`/stub shape (src/stubs.ts: legacy `MP`/leaderboard were
 * stubbed out for Phase 0). Keeps legacy's two-tab shape — "biggest fish" and "species records"
 * — and its row layout (`<li><b>name</b><span>sub</span><em>weight</em></li>`, a `.me` class for
 * the viewer's own row) almost verbatim from `renderLB`/`lbRows` (legacy/index.html), since
 * "players will recognise it" (task brief) is the explicit goal. The one real change is the data
 * source: legacy read `LB.docs`, a client-writable room document anyone could forge; this reads
 * apps/api's `/leaderboard/overall` and `/leaderboard/species`, which are populated only from
 * server-generated catch rows (docs/ARCHITECTURE.md: "the leaderboard is reachable only through
 * server-generated catch rows") — see ui/leaderboard/api.ts.
 *
 * Works whether or not the player is logged in: logged out, it's just a read-only board with no
 * "you" row highlighted; logged in, your own rows highlight the same way legacy's did.
 */
import { SPECIES } from '@keysrun/shared/content/species';
import { fetchOverall, fetchPlayerRecords, fetchSpecies, type OverallRow, type SpeciesRow } from './api.js';
import { logOutAndReload } from '../auth/gate.js';
import './leaderboard.css';

export interface LeaderboardIdentity {
  token: string;
  userId: string;
  displayName: string;
}

export interface LeaderboardHandle {
  dispose(): void;
}

type Tab = 'big' | 'sp';

export function mountLeaderboard(wrap: HTMLElement, identity: LeaderboardIdentity | null): LeaderboardHandle {
  const openBtn = document.createElement('button');
  openBtn.className = 'krLbOpenBtn';
  openBtn.textContent = '🏆 Leaderboard';
  wrap.appendChild(openBtn);

  const panel = document.createElement('div');
  panel.className = 'krLbPanel hidden';
  panel.innerHTML = `
    <div class="krLbCard" role="dialog" aria-label="Leaderboard">
      <div class="krLbHead">
        <h2>Leaderboard</h2>
        <button type="button" class="krLbClose" aria-label="Close">✕</button>
      </div>
      <div class="krLbTabs" role="tablist">
        <button type="button" data-tab="big" aria-pressed="true">Biggest fish</button>
        <button type="button" data-tab="sp" aria-pressed="false">Species records</button>
      </div>
      <ul class="krLbList"></ul>
      <p class="krLbSub"></p>
      ${identity ? '<button type="button" class="krLbLogout">Log out</button>' : ''}
    </div>
  `;
  wrap.appendChild(panel);

  const listEl = panel.querySelector('.krLbList') as HTMLUListElement;
  const subEl = panel.querySelector('.krLbSub') as HTMLElement;
  const tabs = panel.querySelectorAll<HTMLButtonElement>('[data-tab]');
  const closeBtn = panel.querySelector('.krLbClose') as HTMLButtonElement;
  const logoutBtn = panel.querySelector('.krLbLogout') as HTMLButtonElement | null;

  let tab: Tab = 'big';
  let loaded = false;

  function row(name: string, sub: string, weight: string, me: boolean): void {
    const li = document.createElement('li');
    if (me) li.className = 'me';
    const b = document.createElement('b'); b.textContent = name;
    const span = document.createElement('span'); span.textContent = sub;
    const em = document.createElement('em'); em.textContent = weight;
    li.append(b, span, em);
    listEl.appendChild(li);
  }

  function emptyRow(text: string): void {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    listEl.appendChild(li);
  }

  async function renderBig(): Promise<void> {
    let rows: OverallRow[];
    try {
      rows = (await fetchOverall()).rows;
    } catch {
      emptyRow('Could not reach the leaderboard. Try again later.');
      subEl.textContent = '';
      return;
    }
    if (rows.length === 0) {
      emptyRow('No fish yet — land one to get on the board.');
    } else {
      for (const r of rows) {
        const me = identity?.userId === r.userId;
        const speciesName = SPECIES[r.speciesKey]?.name ?? r.speciesKey;
        row(`${r.rank}. ${me ? 'You' : r.displayName}`, `${speciesName} · ${r.catchCount} fish total`, `${r.weightLb.toFixed(1)} lb`, me);
      }
    }
    subEl.textContent = identity ? `Signed in as ${identity.displayName}.` : 'Log in to get your own catches on the board.';
  }

  async function renderSpecies(): Promise<void> {
    let rows: SpeciesRow[];
    try {
      rows = (await fetchSpecies()).rows;
    } catch {
      emptyRow('Could not reach the leaderboard. Try again later.');
      subEl.textContent = '';
      return;
    }
    let mineCount = 0;
    let mySpecies: Record<string, number> | null = null;
    if (identity) {
      try { mySpecies = (await fetchPlayerRecords(identity.userId)).sp; } catch { mySpecies = null; }
    }
    for (const r of rows) {
      const name = SPECIES[r.speciesKey]?.name ?? r.speciesKey;
      const me = !!identity && r.top?.userId === identity.userId;
      if (mySpecies && mySpecies[r.speciesKey]) mineCount++;
      row(name, r.top ? (me ? 'You' : r.top.displayName) : 'No one yet', r.top ? `${r.top.weightLb.toFixed(1)} lb` : '—', me);
    }
    subEl.textContent = identity
      ? `You have caught ${mineCount} of ${rows.length} species.`
      : 'Log in to track your own species records.';
  }

  async function render(): Promise<void> {
    listEl.innerHTML = '';
    emptyRow('Loading…');
    tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tab === tab)));
    await (tab === 'big' ? renderBig() : renderSpecies());
    listEl.querySelector('li.empty')?.remove(); // drop the "Loading…" placeholder (left alone if renderBig/renderSpecies added their own empty-state row instead of real rows)
  }

  tabs.forEach((t) => t.addEventListener('click', () => {
    const next = t.dataset.tab as Tab;
    if (next === tab) return;
    tab = next;
    void render();
  }));

  function open(): void {
    panel.classList.remove('hidden');
    if (!loaded) { loaded = true; void render(); }
    else void render(); // cheap reads; refresh on every open so the board is never stale
  }
  function close(): void {
    panel.classList.add('hidden');
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
  logoutBtn?.addEventListener('click', () => { if (identity) void logOutAndReload(identity.token); });

  return {
    dispose() {
      openBtn.remove();
      panel.remove();
    },
  };
}
