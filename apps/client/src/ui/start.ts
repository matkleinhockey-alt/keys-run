/**
 * Start screen: boat selection cards (with an SVG profile rendered from the same hull-loft math
 * as the 3D model) and the "leave the dock" / "switch boat" flow.
 *
 * Ported from legacy/index.html:4132-4176, with the fishing/leaderboard/cooler copy trimmed
 * from the lede and the controls hint (see src/stubs.ts).
 */
import type { Boat } from '@keysrun/shared/content/boats';
import { hullStation, zRake } from '../entities/boat/hull.js';
import { toast } from './toast.js';

function hex(c: number): string { return '#' + c.toString(16).padStart(6, '0'); }

/** legacy `boatSVG` (index.html:4133-4154): a flat side-profile card illustration. */
export function boatSVG(S: Boat): string {
  const H = S.hp, L = S.len, B = S.beam, sc = 230 / 14;
  const X = (z: number) => 150 + z * sc, Y = (y: number) => 58 - y * sc;
  const sts = [];
  for (let i = 0; i <= 30; i++) sts.push(hullStation(H, L, B, i / 30));
  const sheer = sts.map((s) => [X(zRake(H, s, s.ys)), Y(s.ys)]);
  const keel = sts.map((s) => [X(s.z), Y(s.yk)]).reverse();
  const chine = sts.map((s) => [X(zRake(H, s, s.yc)), Y(s.yc)]);
  const cove = sts.map((s) => { const y = s.yc + (s.ys - s.yc) * 0.64; return [X(zRake(H, s, y)), Y(y)]; });
  const P = (a: number[][]) => a.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const st = H.style, n = S.engines, ex = X(L / 2 + (st.mount === 'bracket' ? 1.1 : 0.38));
  let eng = '';
  for (let i = 0; i < n; i++) eng += `<rect x="${(ex - 5 + i * 2.5).toFixed(1)}" y="${Y(H.F + 0.9).toFixed(1)}" width="10" height="${((H.F + 0.9 + H.yk * 0.8) * sc).toFixed(1)}" rx="2.5" fill="${hex(st.eng)}" stroke="#0d3b66" stroke-width=".8"/>`;
  const cz = L * (L > 11 ? -0.01 : 0.03), cl = L * 0.13, deck = H.F - (0.55 + L * 0.012), tz = cz + L * 0.02, tl = L * 0.27, topY = deck + 2.15 + L * 0.01;
  return `<svg viewBox="0 0 300 90" aria-hidden="true">
    ${st.mount === 'bracket' ? `<rect x="${X(L / 2).toFixed(1)}" y="${Y(0.42).toFixed(1)}" width="${(1.0 * sc).toFixed(1)}" height="${(0.32 * sc).toFixed(1)}" fill="${hex(H.colors.hull)}" stroke="#0d3b66" stroke-width=".8"/>` : ''}
    ${eng}
    <line x1="${X(cz - cl * 0.25)}" y1="${Y(deck)}" x2="${X(tz - tl * 0.38)}" y2="${Y(topY)}" stroke="${hex(st.frame)}" stroke-width="2"/>
    <line x1="${X(cz + cl / 2 + 0.95)}" y1="${Y(deck)}" x2="${X(tz + tl * 0.4)}" y2="${Y(topY)}" stroke="${hex(st.frame)}" stroke-width="2"/>
    <rect x="${X(tz - tl / 2).toFixed(1)}" y="${Y(topY + 0.14).toFixed(1)}" width="${(tl * sc).toFixed(1)}" height="${(0.16 * sc).toFixed(1)}" rx="2" fill="${hex(st.topc)}" stroke="#0d3b66" stroke-width=".8"/>
    <polygon points="${P([...sheer, ...keel])}" fill="${hex(H.colors.hull)}" stroke="#0d3b66" stroke-width="1.2"/>
    <polygon points="${P([...chine, ...keel])}" fill="${hex(H.colors.bottom)}" opacity=".9"/>
    <polyline points="${P(chine)}" fill="none" stroke="${hex(H.colors.boot)}" stroke-width="2.5"/>
    ${H.colors.cove ? `<polyline points="${P(cove)}" fill="none" stroke="${hex(H.colors.cove)}" stroke-width="1.6"/>` : ''}
    <polyline points="${P(sheer)}" fill="none" stroke="${hex(H.colors.rub)}" stroke-width="1.8"/>
    <path d="M0 ${Y(0)} Q 75 ${Y(0) - 4} 150 ${Y(0)} T 300 ${Y(0)} L300 90 L0 90Z" fill="rgba(127,227,212,.35)"/></svg>`;
}

/** What the boat cards need to know about the player's money (game/economy/system.ts). Optional:
 * without it every card is selectable and free, as before. */
export interface BoatMarket {
  cash(): number;
  owns(id: string): boolean;
  price(id: string): number;
  /** null = bought (or already owned); otherwise the message to show the player. */
  buy(id: string): string | null;
  select(id: string): void;
  subscribe(f: () => void): () => void;
}

export interface StartScreenCallbacks {
  onSelectBoat(spec: Boat): void;
  onGo(): void;
  market?: BoatMarket;
}

const usd = (n: number): string => '$' + n.toLocaleString('en-US');

export function populateBoatCards(boats: readonly Boat[], initial: Boat, cb: StartScreenCallbacks): void {
  const boatsEl = document.getElementById('boats');
  if (!boatsEl) return;
  boatsEl.innerHTML = '';
  let current = initial;
  boats.forEach((S) => {
    const b = document.createElement('button');
    b.className = 'bcard';
    b.setAttribute('aria-pressed', S === current ? 'true' : 'false');
    const mk = cb.market;
    b.innerHTML = boatSVG(S)
      + `<div class="brand">${S.brand}</div><h3>${S.name}</h3>${S.nickname ? `<div class="nick">"${S.nickname}"</div>` : ''}<div class="pw">${S.power} · about ${S.top} kn · ${S.draftFt} draft${S.cat ? ' · catamaran' : ''}</div>`
      + Object.entries(S.stats).map(([k, v]) => `<div class="stat"><span>${k}</span><i><b style="width:${v * 100}%"></b></i></div>`).join('')
      + `<p>${S.desc}</p>`
      + (mk ? '<div class="price"></div>' : '');
    // Re-run whenever money changes: label and lock state follow the wallet, not the first render.
    let armed = false, armTimer: ReturnType<typeof setTimeout> | undefined;
    const paint = (): void => {
      if (!mk) return;
      const owned = mk.owns(S.id), pr = mk.price(S.id), el = b.querySelector('.price');
      b.classList.toggle('locked', !owned);
      b.setAttribute('aria-label', owned ? `${S.brand} ${S.name}, owned` : `${S.brand} ${S.name}, ${usd(pr)}, ${mk.cash() >= pr ? 'tap to buy' : 'not enough cash'}`);
      if (el) {
        el.textContent = owned ? 'Owned' : armed ? `Tap again to buy · ${usd(pr)}` : mk.cash() >= pr ? `Buy · ${usd(pr)}` : `${usd(pr)} · need ${usd(pr - mk.cash())} more`;
        el.className = 'price ' + (owned ? 'owned' : mk.cash() >= pr ? '' : 'short');
      }
    };
    paint();
    mk?.subscribe(paint);
    b.addEventListener('click', () => {
      // An unowned hull buys on a confirming second click if affordable; otherwise the card says why not. Only an
      // owned hull is ever handed to onSelectBoat, so the world can't be put in a boat unpaid for.
      if (mk && !mk.owns(S.id)) {
        // Two taps for a purchase: these are $8k-$125k decisions and a stray click on the grid
        // shouldn't spend a session's work.
        if (mk.cash() < mk.price(S.id)) { toast(mk.buy(S.id) ?? ''); return; }
        if (!armed) { armed = true; paint(); clearTimeout(armTimer); armTimer = setTimeout(() => { armed = false; paint(); }, 4000); return; }
        clearTimeout(armTimer); armed = false;
        const refusal = mk.buy(S.id);
        if (refusal) { toast(refusal); return; }
      }
      mk?.select(S.id);
      current = S;
      boatsEl.querySelectorAll('.bcard').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      cb.onSelectBoat(S);
    });
    boatsEl.appendChild(b);
  });
  document.getElementById('btnGo')?.addEventListener('click', cb.onGo);
}

export function showHud(): void {
  document.getElementById('start')?.classList.add('hidden');
  document.getElementById('hud')?.classList.remove('hidden');
}

export function showStart(): void {
  document.getElementById('start')?.classList.remove('hidden');
  document.getElementById('hud')?.classList.add('hidden');
}
