/**
 * Cooler: keep or release (legacy index.html:2963-3009) — `keepFish`/`releaseFish`/`weighIn`,
 * the dock price line, and the catch-and-release-only species list.
 */
import { COOLER_CAP } from '@keysrun/shared/content/boats';
import { MEAT_PRICE, NO_SALE } from '@keysrun/shared/content/economy';
import { MARINAS, type Marina } from '@keysrun/shared/world/depth';
import { clamp } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import { coolerCapFor, ICE_KEY, ICE_BONUS_LB, type GearPort } from '@keysrun/shared/sim/gear';
import { countOf, useOne } from '@keysrun/shared/sim/shop';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export interface CoolerFish {
  name: string;
  key: string;
  weight: number;
  inches: number;
  sex: string;
  pts: number;
}

/** legacy `CR_ONLY` (index.html:2965) — species that must be released regardless of cooler space. */
export const CR_ONLY: Record<string, string> = {
  goliath: 'Goliath grouper are protected in Florida — release it in the water.',
  hammerhead: 'Great hammerheads must be released in Florida waters.',
  lemonshark: 'Lemon sharks are protected in Florida state waters.',
  bonefish: 'Bonefish are catch-and-release only in Florida.',
  tarpon: 'Tarpon are catch-and-release in Florida unless you hold a harvest tag.',
};

/** legacy `meatLine` (index.html:2912). */
export function meatLine(key: string, w: number): string {
  if (NO_SALE[key]) return NO_SALE[key];
  const p = MEAT_PRICE[key];
  if (!p) return '';
  const fil = w * 0.42;
  return `$${p}/lb fillets · ~${fil.toFixed(1)} lb of meat ≈ $${Math.round(fil * p).toLocaleString()}`;
}

/** legacy `nearMarina` (index.html:1738), using the shared `MARINAS` table directly rather than
 * apps/client/src/world/marinas.ts's dock-rect geometry (out of this task's scope — see the
 * task brief's "Do NOT edit world/**"). */
export function nearMarina(boatX: number, boatZ: number): Marina | null {
  for (const M of MARINAS) {
    const dz = clamp(boatZ, Math.min(M.sz, M.ez), Math.max(M.sz, M.ez));
    if (Math.hypot(boatX - M.sx, boatZ - dz) < 20) return M;
  }
  return null;
}

/**
 * `gear` is optional: without it the cooler is exactly the boat's base capacity.
 *
 * ICE. A bag is spent when the first fish of a load goes in (`keepFish`) and keeps that load iced
 * (+ICE_BONUS_LB) until the weigh-in empties the cooler. Spending at keep-time rather than at
 * purchase or at the dock means a bag is only used when it is used, and a load you never keep
 * anything in costs nothing. The catch: the keep-or-release card is built BEFORE the fish is
 * kept, so `capNow` counts a bag you are *about to* spend as already open — otherwise the one
 * fish that needs the extra room (a 40 lb cobia into a 150 lb robalo already at 120) would be
 * refused by a cap that the very same keep would raise.
 */
export function createCooler(gear?: GearPort) {
  const cooler: CoolerFish[] = [];
  let iced = false;
  const capNow = (boatId: string): number => {
    const base = COOLER_CAP[boatId] ?? 300;
    if (!gear) return base;
    const willIce = !iced && countOf(gear.inventory(), ICE_KEY) > 0;
    return coolerCapFor(base, gear.mods(0), iced || willIce);
  };
  const coolerLb = (): number => cooler.reduce((a, f) => a + f.weight, 0);

  function updateCoolerUI(): void {
    const el = $('coolerTxt');
    if (el) el.textContent = `${cooler.length} fish · ${Math.round(coolerLb())} lb`;
  }

  /** legacy `prepareKeepChoice` (index.html:2969-2974). Returns whether `btnKeep` should be
   * disabled, and the note to show under the catch card. */
  function prepareKeepChoice(boatId: string, key: string, weight: number): { disabled: boolean; note: string } {
    const cap = capNow(boatId);
    const left = cap - coolerLb();
    let note = '';
    if (CR_ONLY[key]) note = CR_ONLY[key];
    else if (weight > left) note = `Too big for your cooler — ${Math.max(0, Math.round(left))} lb of space left. Weigh in at a marina to empty it.`;
    return { disabled: !!note, note: note || 'Release for a 25% conservation bonus, or keep it and weigh in at a marina dock (⚓ on your chart).' };
  }

  /** legacy `keepFish` (index.html:2975-2979), minus the DOM-disabled re-check (the caller —
   * game/catch/catch-flow.ts — already knows whether keeping is allowed). */
  function keepFish(fish: CoolerFish): void {
    if (gear && !iced && countOf(gear.inventory(), ICE_KEY) > 0) {
      gear.commit(useOne(gear.inventory(), ICE_KEY));
      iced = true;
      toast(`Bag of ice dumped in — cooler holds ${ICE_BONUS_LB} lb more until you weigh in.`);
    }
    cooler.push(fish);
    updateCoolerUI();
  }

  function openCooler(boatBrand: string, boatName: string, boatId: string): void {
    const cap = capNow(boatId);
    const capEl = $('coolerCap');
    if (capEl) capEl.textContent = `${Math.round(coolerLb())} of ${cap} lb · ${boatBrand} ${boatName}`;
    const list = $('coolerList');
    if (list) {
      list.innerHTML = cooler.length
        ? cooler.map((f) => `<li><b>${f.name}</b><span>${f.weight.toFixed(1)} lb · ${f.inches} in · ${f.sex}</span></li>`).join('')
        : '<li class="empty">Nothing on ice yet. Keep a fish after you land it.</li>';
    }
    $('coolerPanel')?.classList.remove('hidden');
    $('btnCoolerClose')?.focus();
  }

  /** legacy `weighIn(M)` (index.html:3003-3009). Returns the points bonus (the caller adds it to
   * the session score) and a summary string, or `null` if the cooler was empty. `locationName`
   * is legacy's `M.name` — optional here only because a caller with no marina reference on hand
   * (there shouldn't be one; see catch-flow.ts's `weighIn`) still gets a sensible message. */
  function weighIn(locationName?: string): { bonus: number; summary: string } | null {
    if (!cooler.length) return null;
    const lb = coolerLb();
    const bonus = Math.round(lb * 6);
    const big = cooler.reduce((a, f) => (f.weight > a.weight ? f : a));
    const where = locationName ? ` at ${locationName}` : '';
    const summary = `Weighed in ${cooler.length} fish (${Math.round(lb)} lb)${where}. Top fish: ${big.name}, ${big.weight.toFixed(1)} lb. +${bonus.toLocaleString()} points!`;
    cooler.length = 0;
    iced = false; // the ice melts by the time you are back out; a new load needs a new bag
    updateCoolerUI();
    return { bonus, summary };
  }

  updateCoolerUI();
  return { cooler, coolerLb, updateCoolerUI, prepareKeepChoice, keepFish, openCooler, weighIn };
}
