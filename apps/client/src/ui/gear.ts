/**
 * The gear screen (Tab, or the Gear button): what you own, what you are carrying, what is running
 * and for how long, and — the part that makes a purchase feel real — what all of it adds up to in
 * human terms ("Bottom time 90 s -> 252 s"), not raw multipliers.
 *
 * Also owns the translation from the shared `Modifiers` bag to words, because the shop panel needs
 * the same thing for a single item ("this fin gives you +28% swim speed") before you buy it. One
 * formatter means the shelf's promise and the gear screen's report cannot drift apart.
 *
 * The item-effect text is DERIVED, not authored: `describeItem` runs `modifiersFor` on an inventory
 * holding only that item and diffs it against nothing. Rejected: a hand-written effect string per
 * item in venues.ts (which is frozen anyway) — it would be a second copy of the numbers in
 * sim/shop.ts that is wrong the first time someone retunes a multiplier.
 *
 * DOM is built here rather than in index.html, like entities/land/hud.ts, and styled by gear.css.
 */
import { VENUES, type ShelfItem, type VenueId } from '@keysrun/shared/content/venues';
import { AIR_MAX } from '@keysrun/shared/sim/diver';
import { SPEAR_RANGE } from '@keysrun/shared/sim/spear';
import { MAG_SIZE } from '@keysrun/shared/sim/handgun';
import { emptyInventory, modifiersFor, type Inventory, type Modifiers } from '@keysrun/shared/sim/shop';
import './gear.css';

/** What the shop panel and gear screen may ask of the economy (see game/economy/system.ts `shop`). */
export interface ShopPort {
  cash(): number;
  inventory(): Inventory;
  /** Simulated seconds; buffs expire against this. */
  clock(): number;
  buy(venueId: VenueId, itemId: string): { ok: boolean; message: string };
  subscribe(f: () => void): () => void;
}

export interface EffectRow {
  label: string;
  /** Present when there is a meaningful base to show "from -> to" against. */
  text: string;
  /** Helpful (true) or a liability (false) — colours the row. */
  good: boolean;
}

const pct = (mul: number): string => `${mul >= 1 ? '+' : '-'}${Math.round(Math.abs(mul - 1) * 100)}%`;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** Every field of `m` that differs from "unchanged", in words. Base values come from the same
 * constants the sims use (AIR_MAX, SPEAR_RANGE), so "90 s" is the real stock figure. */
export function describeModifiers(m: Modifiers): EffectRow[] {
  const rows: EffectRow[] = [];
  const mul = (label: string, v: number, better: 'up' | 'down' = 'up'): void => {
    if (near(v, 1)) return;
    rows.push({ label, text: pct(v), good: better === 'up' ? v > 1 : v < 1 });
  };
  if (!near(m.breathMul, 1)) {
    rows.push({ label: 'Bottom time', text: `${Math.round(AIR_MAX)} s → ${Math.round(AIR_MAX * m.breathMul)} s`, good: m.breathMul > 1 });
  }
  mul('Swim speed', m.swimMul);
  if (m.viewBonusM) rows.push({ label: 'Underwater view', text: `+${Math.round(m.viewBonusM)} m`, good: m.viewBonusM > 0 });
  if (m.spearRangeM) rows.push({ label: 'Spear range', text: `${SPEAR_RANGE} m → ${SPEAR_RANGE + Math.round(m.spearRangeM)} m`, good: m.spearRangeM > 0 });
  mul('Speared fish run', m.spearTetherMul, 'down');
  mul('Line strength', m.lineMul);
  mul('Reel speed', m.reelMul);
  mul('Bite wait', m.biteMul, 'down');
  mul('Rare fish odds', m.rareMul);
  if (m.coolerBonusLb) rows.push({ label: 'Cooler space', text: `+${Math.round(m.coolerBonusLb)} lb`, good: m.coolerBonusLb > 0 });
  mul('Steady hands', m.steadyMul);
  if (m.handgunMagBonus) rows.push({ label: 'Pistol magazine', text: `${MAG_SIZE} → ${MAG_SIZE + Math.round(m.handgunMagBonus)} rounds`, good: m.handgunMagBonus > 0 });
  mul('Pistol spread', m.handgunSpreadMul, 'down');
  if (m.sway > 0) rows.push({ label: 'Tipsy', text: `${Math.round(m.sway * 100)}%`, good: false });
  return rows;
}

const ALL_ITEMS: ShelfItem[] = Object.values(VENUES).flatMap((v) => [...v.sells]);
export const itemByKey = (key: string): ShelfItem | undefined => ALL_ITEMS.find((s) => s.effect.key === key);

/** What one item does, as rows. Consumables are spent at the moment of use rather than read from
 * the bag, so they (and sinks, services, cosmetics) have no rows — the shelf shows their blurb. */
export function describeItem(it: ShelfItem): EffectRow[] {
  const inv = emptyInventory();
  const { kind, key } = it.effect;
  const only: Inventory | null = kind === 'gear' ? { ...inv, gear: [key] }
    : kind === 'buff' ? { ...inv, buffs: { [key]: 1e12 } } : null;
  return only ? describeModifiers(modifiersFor(only, 0)) : [];
}

export const rowsText = (rows: EffectRow[]): string => rows.map((r) => `${r.label} ${r.text}`).join(' · ');

export function fmtClock(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface GearScreen { toggle(): void; open(): void; close(): void; isOpen(): boolean }

export function createGearScreen(shop: ShopPort): GearScreen {
  const host = document.getElementById('hud') ?? document.body;
  const panel = document.createElement('div');
  panel.id = 'gearScreen';
  panel.className = 'panel hidden';
  host.append(panel);
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsub: (() => void) | null = null;

  const section = (title: string, body: string, empty: string): string =>
    `<h3>${title}</h3>${body ? `<ul>${body}</ul>` : `<p class="none">${empty}</p>`}`;

  function render(): void {
    const inv = shop.inventory(), now = shop.clock();
    const gear = inv.gear.map((k) => {
      const it = itemByKey(k);
      return `<li><b>${esc(it?.name ?? k)}</b><small>${esc(it ? rowsText(describeItem(it)) || it.blurb : '')}</small></li>`;
    }).join('');
    const carry = Object.entries(inv.consumables).filter(([, n]) => n > 0).map(([k, n]) => {
      const it = itemByKey(k);
      return `<li><b>${esc(it?.name ?? k)}</b><span class="n">×${n}</span></li>`;
    }).join('');
    const buffs = Object.entries(inv.buffs).filter(([, exp]) => exp > now).map(([k, exp]) => {
      const it = itemByKey(k);
      return `<li><b>${esc(it?.name ?? k)}</b><small>${esc(it ? rowsText(describeItem(it)) : '')}</small><span class="n">${fmtClock(exp - now)}</span></li>`;
    }).join('');
    const worn = inv.cosmetics.map((k) => `<li><b>${esc(itemByKey(k)?.name ?? k)}</b></li>`).join('');
    const rows = describeModifiers(modifiersFor(inv, now));
    const eff = rows.length
      ? `<ul class="eff">${rows.map((r) => `<li class="${r.good ? 'good' : 'bad'}"><span>${esc(r.label)}</span><b>${esc(r.text)}</b></li>`).join('')}</ul>`
      : '<p class="none">Nothing yet. Gear from the shops in town changes how you fish, dive and spear.</p>';
    panel.innerHTML = `<div class="gh"><h2>Gear</h2><span class="cash">$${Math.round(shop.cash()).toLocaleString('en-US')}</span><button type="button" id="gearClose" aria-label="Close">✕</button></div>`
      + `<h3>What it adds up to</h3>${eff}`
      + section('Running now', buffs, 'No food or drink in effect.')
      + section('Carrying', carry, 'Nothing in the bag.')
      + section('Owned gear', gear, 'You own nothing permanent yet.')
      + (worn ? section('Wardrobe', worn, '') : '')
      + '<p class="hint">Tab to close. Shops are in Boot Key Harbor City: step ashore at a marina dock (F).</p>';
    panel.querySelector('#gearClose')?.addEventListener('click', close);
  }

  const isOpen = (): boolean => !panel.classList.contains('hidden');
  function open(): void {
    render();
    panel.classList.remove('hidden');
    // Buff countdowns tick in simulated seconds; ~4 Hz repaint is plenty and cheaper than a
    // per-frame subscription for a screen that is only sometimes open.
    timer = setInterval(render, 250);
    unsub = shop.subscribe(render);
  }
  function close(): void {
    panel.classList.add('hidden');
    clearInterval(timer); timer = undefined;
    unsub?.(); unsub = null;
  }

  // Tab, not G/I: every other free-looking letter is bound (G quality, I engine, WASD walk).
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Tab' || e.repeat) return;
    if (document.getElementById('hud')?.classList.contains('hidden')) return; // still at the start screen
    e.preventDefault();
    isOpen() ? close() : open();
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && isOpen()) close(); });

  // A clickable way in, beside the cooler button, for touch and for people who do not read help text.
  const btn = document.createElement('button');
  btn.id = 'btnGear';
  btn.textContent = '🎒 Gear';
  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  const cooler = document.getElementById('btnCooler');
  if (cooler?.parentElement) cooler.parentElement.insertBefore(btn, cooler); else host.append(btn);

  return { toggle: () => (isOpen() ? close() : open()), open, close, isOpen };
}
