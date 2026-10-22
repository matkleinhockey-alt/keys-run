/**
 * The gift shop's changing room: swap what you are wearing, or take it off.
 *
 * Added to the venue panel for `gifts` only, AFTER the panel is open, rather than woven into the
 * panel's own markup: hud.ts's `open()` wires "close" to the first <button> in the panel, so a row of
 * Wear buttons placed above the footer would turn into close buttons. Mounting afterwards also keeps
 * this file independent of whoever owns the shelf/till rendering.
 *
 * It only ever calls `wardrobe.wear` / `wardrobe.takeOff`, which publish through the shared
 * `Inventory.wearing` -- the gear screen shows the same state, there is no second list here.
 * "Everyday" is the take-off button: it clears the slot, and the figure returns to the plain cap,
 * plain shades and default shirt it starts with (see sim/wardrobe.ts for why).
 */
import { COSMETICS, COSMETIC_SLOTS, type CosmeticSlot } from '@keysrun/shared/content/cosmetics';
import { ownedIn } from '@keysrun/shared/sim/wardrobe';
import { wardrobe } from '../life/outfit.js';

const SLOT_LABEL: Record<CosmeticSlot, string> = { shirt: 'Shirt', cap: 'Headwear', glasses: 'Shades', flag: 'Boat flag' };

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

export function mountChangingRoom(panel: HTMLElement): void {
  const host = document.createElement('div');
  host.id = 'changingRoom';
  host.className = 'changing';
  // Above the shelf, not below it: with a dozen items on the shelf the panel scrolls, and a changing
  // room at the bottom would be somewhere nobody looks. (Safe to place anywhere: hud.ts bound its
  // close handler to the footer button before we got here.)
  const shelf = panel.querySelector('.shelf');
  if (shelf) shelf.before(host); else panel.append(host);

  const render = (): void => {
    const inv = wardrobe.get();
    if (!inv.cosmetics.length) {
      host.innerHTML = '<h3>Changing room</h3><p class="blurb">Nothing bought yet. Whatever you buy here, you wear.</p>';
      return;
    }
    const rows = COSMETIC_SLOTS.map((slot) => {
      const owned = ownedIn(inv, slot);
      if (!owned.length) return '';
      const on = inv.wearing[slot];
      const btn = (key: string | null, label: string, swatch: number | null): string =>
        `<button type="button" class="wear${(on ?? null) === key ? ' on' : ''}" data-slot="${slot}" data-key="${key ?? ''}" aria-pressed="${(on ?? null) === key}">${swatch === null ? '' : `<i style="background:${hex(swatch)}"></i>`}${esc(label)}</button>`;
      return `<div class="slotrow"><span>${SLOT_LABEL[slot]}</span>${btn(null, 'Everyday', null)}${owned.map((k) => btn(k, COSMETICS[k].name, COSMETICS[k].swatch)).join('')}</div>`;
    }).join('');
    host.innerHTML = `<h3>Changing room</h3>${rows}`;
  };
  host.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button.wear');
    if (!b) return;
    const key = b.dataset.key, slot = b.dataset.slot!;
    if (key) wardrobe.wear(key); else wardrobe.takeOff(slot);
    render();
  });
  render();
}
