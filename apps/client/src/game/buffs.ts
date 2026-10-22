/**
 * Runtime for timed food/drink buffs: expiry, toasts, the on-screen strip, and the `Modifiers` bag
 * the rest of the client reads.
 *
 * ## State lives in `Inventory.buffs`, nowhere else
 *
 * This module owns NO buff state of its own. It reads and (to prune) writes the shared inventory
 * through two accessors, so the gear/inventory screen shows the same buffs for free and a reload
 * that persists the inventory persists the buffs. The only thing kept here is the previous frame's
 * expiry map, purely to detect "just started" / "just ended" for toasts.
 *
 * ## Expiry
 *
 * `update(nowS)` must be called once per frame with SIMULATED seconds (world.ts's `simTime`, the
 * same clock `buy()` stamps expiries with). It prunes first, then derives modifiers from the pruned
 * inventory, so nothing downstream can read a stale buff. `modifiersFor` also filters on `nowS`
 * itself, so even a consumer holding last frame's inventory cannot see an expired buff.
 *
 * Simulated, not wall-clock: a paused or backgrounded tab does not burn your coffee.
 */
import { modifiersFor, pruneBuffs, NO_MODIFIERS, type Inventory, type Modifiers } from '@keysrun/shared/sim/shop';
import { BUFF_LABELS, buffEdges, endToast, isDrink, liveBuffs, startToast } from '@keysrun/shared/sim/steady';

export interface BuffRuntimeDeps {
  getInventory(): Inventory;
  /** Called only when pruning actually changed something. */
  setInventory(inv: Inventory): void;
  toast(msg: string): void;
  /** Where to mount the strip. Omitted = no HUD (tests, harnesses). */
  mount?: HTMLElement | null;
}

export interface BuffRuntime {
  /** Latest modifiers; stable object per frame, safe to read from fixed steps. */
  readonly mods: Modifiers;
  update(nowS: number): Modifiers;
}

const fmt = (s: number): string => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

export function createBuffRuntime(deps: BuffRuntimeDeps): BuffRuntime {
  let prevExp: Record<string, number> | null = null; // null = first frame: adopt silently, no toasts
  let sig = '';
  let strip: HTMLElement | null = null;
  if (deps.mount) {
    strip = document.createElement('div');
    strip.id = 'buffs';
    deps.mount.appendChild(strip);
  }
  const rt: { mods: Modifiers; update(nowS: number): Modifiers } = {
    mods: NO_MODIFIERS,
    update(nowS) {
      let inv = deps.getInventory();
      const pruned = pruneBuffs(inv, nowS);
      if (pruned !== inv) { deps.setInventory(pruned); inv = pruned; }

      const exp = inv.buffs;
      if (prevExp) {
        const edges = buffEdges(new Set(Object.keys(prevExp)), new Set(Object.keys(exp)));
        for (const k of edges.started) deps.toast(startToast(k));
        // A second coffee extends rather than stacks (shop.ts buy()); say so instead of staying silent.
        for (const k of Object.keys(exp)) {
          if (prevExp[k] !== undefined && exp[k] > prevExp[k]) deps.toast((BUFF_LABELS[k] ?? k) + ': topped up.');
        }
        for (const k of edges.ended) deps.toast(endToast(k));
      }
      prevExp = { ...exp };

      rt.mods = modifiersFor(inv, nowS);

      if (strip) {
        const live = liveBuffs(exp, nowS);
        const s = live.map((b) => b.key + b.left).join('|');
        if (s !== sig) {
          sig = s;
          strip.innerHTML = live
            .map((b) => `<span class="buff${isDrink(b.key) ? ' drink' : ''}">${BUFF_LABELS[b.key] ?? b.key} ${fmt(b.left)}</span>`)
            .join('');
        }
      }
      return rt.mods;
    },
  };
  return rt;
}
