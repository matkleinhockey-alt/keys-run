/**
 * The pistol's HUD: crosshair, ammunition, a reload bar, a hit tally and a key-help line.
 *
 * Built once and reused (idempotent, like entities/land/hud.ts), inside `#hud` so the start screen
 * hides it with everything else. Plain DOM and a stylesheet beside it rather than edits to the
 * shared index.html/style.css, which half a dozen other agents are editing.
 *
 * The magazine is drawn as pips as well as a number: the number is for reading, the pips are for
 * glancing, and with the gun held open (empty) the row of dark pips is visible at the edge of the
 * eye while you are looking at a gull.
 */
import './handgun.css';

export interface GunHud {
  show(v: boolean): void;
  /** `mag` rounds loaded of `size`, `reserve` more carried. */
  setAmmo(mag: number, size: number, reserve: number): void;
  setReload(frac: number | null): void;
  setNote(text: string, bad?: boolean): void;
  setScore(fish: number, birds: number, caelen: number): void;
  setCross(state: 'idle' | 'lock'): void;
  flashHit(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export function createGunHud(isTouch: boolean, handlers: { fire(): void; reload(): void; holster(): void }): GunHud {
  const host = document.getElementById('hud') ?? document.body;
  const root = el('div'); root.id = 'gunHud'; root.classList.add('hidden');
  const cross = el('div', 'gh-cross');
  const ammo = el('div', 'gh-ammo panel');
  const mag = el('div', 'gh-mag', '<b>0</b><span>/ 0</span>');
  const pips = el('div', 'gh-pips');
  const bar = el('div', 'gh-bar'); const barFill = el('i'); bar.append(barFill); bar.style.display = 'none';
  const note = el('div', 'gh-note');
  ammo.append(mag, pips, bar, note);
  const help = el('div', 'gh-help', isTouch
    ? 'Tap to fire · drag to aim'
    : 'Click / Space fire · R reload · Z flare · drag or arrows to aim · 9 or Esc holster');
  const score = el('div', 'gh-score panel');
  root.append(cross, ammo, help, score);
  host.append(root);

  let touch: HTMLElement | null = null;
  if (isTouch) {
    touch = el('div'); touch.id = 'touchGun'; touch.classList.add('hidden');
    const mk = (id: string, label: string, title: string, fn: () => void): void => {
      const b = el('button', 'tbtn', label); b.id = id; b.setAttribute('aria-label', title);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      touch!.append(b);
    };
    mk('tgFire', '\u{1F52B}', 'Fire', handlers.fire);
    mk('tgReload', '↻', 'Reload', handlers.reload);
    mk('tgHolster', '✕', 'Holster', handlers.holster);
    (document.getElementById('wrap') ?? document.body).append(touch);
  }

  let lastPips = '';
  let hitT = 0;
  return {
    show(v) {
      root.classList.toggle('hidden', !v);
      touch?.classList.toggle('hidden', !v);
      if (!v) { cross.classList.remove('lock', 'hit'); }
    },
    setAmmo(m, size, reserve) {
      (mag.firstElementChild as HTMLElement).textContent = String(m);
      (mag.lastElementChild as HTMLElement).textContent = `/ ${reserve}`;
      mag.classList.toggle('low', m <= 3);
      const key = `${m}/${size}`;
      if (key !== lastPips) {
        lastPips = key;
        pips.innerHTML = Array.from({ length: size }, (_, i) => `<i class="${i < m ? '' : 'off'}"></i>`).join('');
      }
    },
    setReload(f) {
      bar.style.display = f === null ? 'none' : 'block';
      if (f !== null) barFill.style.width = `${Math.round(f * 100)}%`;
    },
    setNote(text, bad = false) {
      if (note.textContent !== text) note.textContent = text;
      note.classList.toggle('bad', bad);
    },
    setScore(fish, birds, caelen) {
      score.innerHTML = `Fish stunned <b>${fish}</b> · Birds startled <b>${birds}</b>` + (caelen ? ` · Caelen <b>${caelen}</b>` : '');
    },
    setCross(s) { if (hitT <= 0) cross.classList.toggle('lock', s === 'lock'); },
    flashHit() {
      cross.classList.remove('lock'); cross.classList.add('hit');
      hitT = 1;
      setTimeout(() => { cross.classList.remove('hit'); hitT = 0; }, 160);
    },
    dispose() { root.remove(); touch?.remove(); },
  };
}
