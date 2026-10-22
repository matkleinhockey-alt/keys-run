/**
 * Land HUD: where you are, where the boat is, what you can do right here, and the venue panel.
 *
 * The DOM is built here, once, rather than added to index.html: land mode is a peer of the diver
 * (whose HUD lives in index.html), and keeping its markup beside the module that drives it means
 * the page stays untouched. Everything is appended inside `#hud` so it inherits the "hidden until
 * the game starts" behaviour, and every element has a stable id for the Playwright harness.
 *
 * The venue panel is the hook for the economy: it lists each venue's `sells` straight from
 * `@keysrun/shared/content/venues`, greyed out and tagged "stock arriving" while every item is
 * `status: 'planned'`. When an item goes `'live'` the same row gains a Buy button here; nothing
 * about the venues needs to change.
 */
import { VENUES, type Venue } from '@keysrun/shared/content/venues';
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
export function createLandHud(touch: boolean): LandHudHandles {
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
    p.querySelector('button')?.addEventListener('click', close);
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
      const shelf = v.sells.length
        ? `<ul class="shelf">${v.sells.map((s) => `<li><b>${esc(s.name)}</b><small>${esc(s.blurb)}</small><span class="px">$${s.price}<i>${s.status === 'planned' ? 'stock arriving' : 'in stock'}</i></span></li>`).join('')}</ul>`
        : '<p class="blurb">Nothing on the shelves for you yet.</p>';
      open(`<h2>${esc(v.name)}</h2><div class="vtag">${esc(v.tagline)}</div><p class="say">“${esc(say)}”</p><p class="blurb">${esc(v.blurb)}</p>${shelf}<div class="foot"><span>Nothing is for sale yet — the till opens when the economy does.</span><button type="button" id="landPanelClose">Back outside</button></div>`, cb);
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
