/**
 * Land HUD: where you are, where the boat is, what you can do right here, and the venue panel.
 *
 * The DOM is built here, once, rather than added to index.html: land mode is a peer of the diver
 * (whose HUD lives in index.html), and keeping its markup beside the module that drives it means
 * the page stays untouched. Everything is appended inside `#hud` so it inherits the "hidden until
 * the game starts" behaviour, and every element has a stable id for the Playwright harness.
 *
 * The venue panel lists each venue's `sells` straight from `@keysrun/shared/content/venues` and
 * sells it through the `ShopPort` (ui/gear.ts, backed by game/economy/system.ts). Every row shows
 * its price, what it does in words (derived from the shared modifier bag, so it cannot disagree
 * with the gear screen), and its state for you: owned / carrying N / running. A refusal — can't
 * afford, already own — is shown in the footer in words rather than silently ignored.
 */
import { VENUES, type Venue } from '@keysrun/shared/content/venues';
import { describeItem, fmtClock, rowsText, type ShopPort } from '../../ui/gear.js';
import './land.css';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export interface LandHudHandles {
  showHud(show: boolean): void;
  showTouch(show: boolean): void;
  setPlace(place: string, sub: string): void;
  setBoat(html: string): void;
  setPrompt(text: string | null): void;
  setDockPrompt(text: string | null): void;
  openVenue(id: Venue['id'], visit: number, onClose: () => void): void;
  openPlaque(title: string, text: string, onClose: () => void): void;
  closePanel(): void;
  panelOpen(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, id: string | null, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (id) e.id = id;
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** Builds (once) and returns the handles. Idempotent: a second call returns the same DOM. */
export function createLandHud(touch: boolean, shop: ShopPort): LandHudHandles {
  const host = $('hud') ?? document.body;
  if (!$('landHud')) {
    const hud = el('div', 'landHud', 'hidden');
    const card = el('div', null, 'landCard panel');
    card.append(el('span', 'landPlace'), el('span', 'landSub'), el('span', 'landBoat'));
    hud.append(card, el('div', 'landHelp', '', 'WASD walk · Shift run · drag to look · V first / third person · F use · B back to the boat'));
    host.append(hud, el('div', 'landPrompt', 'hidden'), el('div', 'dockPrompt', 'hidden'), el('div', 'landPanel', 'panel hidden'));
    if (touch) {
      const pad = el('div', 'touchLand', 'hidden');
      for (const [id, label, title] of [['tlL', '◀', 'Left'], ['tlR', '▶', 'Right'], ['tlUp', '▲', 'Forward'], ['tlDn', '▼', 'Back'], ['tlRun', '⚡', 'Run'], ['tlAct', 'F', 'Use'], ['tlBoat', '⚓', 'Back to the boat']] as const) {
        const b = el('button', id, 'tbtn', label); b.setAttribute('aria-label', title); pad.append(b);
      }
      ($('wrap') ?? document.body).append(pad);
    }
  }
  let onClose: (() => void) | null = null;

  const close = (): void => {
    $('landPanel')?.classList.add('hidden');
    const cb = onClose; onClose = null;
    cb?.();
  };
  const open = (html: string, cb: () => void): void => {
    const p = $('landPanel');
    if (!p) return;
    p.innerHTML = html;
    p.classList.remove('hidden');
    onClose = cb;
    p.querySelector('#landPanelClose')?.addEventListener('click', close);
  };

  return {
    showHud(show) { $('landHud')?.classList.toggle('hidden', !show); if (!show) { $('landPrompt')?.classList.add('hidden'); close(); } },
    showTouch(show) { $('touchLand')?.classList.toggle('hidden', !show); },
    setPlace(place, sub) { const a = $('landPlace'), b = $('landSub'); if (a && a.textContent !== place) a.textContent = place; if (b && b.textContent !== sub) b.textContent = sub; },
    setBoat(html) { const b = $('landBoat'); if (b && b.innerHTML !== html) b.innerHTML = html; },
    setPrompt(text) {
      const p = $('landPrompt'); if (!p) return;
      p.classList.toggle('hidden', !text);
      if (text) { const [k, ...rest] = text.split(/\s{2,}/); const h = `<kbd>${k}</kbd>${rest.join(' ')}`; if (p.innerHTML !== h) p.innerHTML = h; }
    },
    setDockPrompt(text) {
      const p = $('dockPrompt'); if (!p) return;
      p.classList.toggle('hidden', !text);
      if (text) { const [k, ...rest] = text.split(/\s{2,}/); const h = `<kbd>${k}</kbd>${rest.join(' ')}`; if (p.innerHTML !== h) p.innerHTML = h; }
    },
    openVenue(id, visit, cb) {
      const v = VENUES[id];
      const say = v.greeting[visit % v.greeting.length];
      let msg = '', bad = false;
      const render = (): void => {
        const p = $('landPanel'); if (!p) return;
        const keep = p.scrollTop;
        const inv = shop.inventory(), now = shop.clock(), cash = shop.cash();
        const row = (s: (typeof v.sells)[number]): string => {
          const { kind, key } = s.effect;
          const owned = (kind === 'gear' && inv.gear.includes(key)) || (kind === 'cosmetic' && inv.cosmetics.includes(key));
          const carried = inv.consumables[key] ?? 0;
          const left = (inv.buffs[key] ?? 0) - now;
          const fx = rowsText(describeItem(s));
          const note = owned ? 'Owned' : left > 0 ? `Running ${fmtClock(left)}` : carried > 0 ? `Carrying ${carried}` : s.price > cash ? `Need $${Math.ceil(s.price - cash).toLocaleString('en-US')} more` : '';
          const live = s.status === 'live';
          const label = !live ? 'Soon' : owned ? 'Owned' : 'Buy';
          return `<li class="${owned ? 'own' : ''}"><b>${esc(s.name)}</b><small>${esc(s.blurb)}</small>${fx ? `<em>${esc(fx)}</em>` : ''}`
            + `<span class="px">$${s.price.toLocaleString('en-US')}<i>${esc(note)}</i><button type="button" class="buy${live && !owned && s.price > cash ? ' poor' : ''}" data-item="${esc(s.id)}"${live && !owned ? '' : ' disabled'}>${label}</button></span></li>`;
        };
        const shelf = v.sells.length
          ? `<ul class="shelf">${v.sells.map(row).join('')}</ul>`
          : '<p class="blurb">Nothing on the shelves for you yet.</p>';
        p.innerHTML = `<h2>${esc(v.name)}</h2><div class="vtag">${esc(v.tagline)}</div><p class="say">\u201c${esc(say)}\u201d</p><p class="blurb">${esc(v.blurb)}</p>${shelf}`
          + `<div class="foot"><span id="shopMsg" class="${bad ? 'bad' : ''}">${esc(msg)}</span><b class="wallet">Cash $${Math.round(cash).toLocaleString('en-US')}</b><button type="button" id="landPanelClose">Back outside</button></div>`;
        p.scrollTop = keep;
      };
      open('', cb);
      render();
      const p = $('landPanel')!;
      // One delegated listener: render() replaces the whole subtree on every purchase, so
      // per-button handlers would be rebuilt (and leaked) each time. `open` already installed the
      // close handler on the first button, which at that moment did not exist — hence the
      // explicit #landPanelClose lookup via delegation below instead.
      p.onclick = (e) => {
        const t = e.target as HTMLElement;
        if (t.closest('#landPanelClose')) { close(); return; }
        const b = t.closest<HTMLButtonElement>('button.buy');
        if (!b || b.disabled) return;
        const r = shop.buy(id, b.dataset.item ?? '');
        msg = r.message; bad = !r.ok;
        render();
      };
      const unsub = shop.subscribe(render);
      const prev = onClose;
      onClose = () => { unsub(); p.onclick = null; prev?.(); };
    },
    openPlaque(title, text, cb) {
      open(`<h2>${esc(title)}</h2><p class="blurb" style="margin-top:12px">${esc(text)}</p><div class="foot"><span></span><button type="button" id="landPanelClose">Carry on</button></div>`, cb);
    },
    closePanel: close,
    panelOpen: () => !$('landPanel')?.classList.contains('hidden'),
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
