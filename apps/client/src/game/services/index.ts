/**
 * Client glue for the town's services (the rules are pure, in packages/shared/src/sim/services.ts).
 * This file owns what the shared module must not: localStorage, the DOM overlay, the sky, the wallet
 * credit for lotto winnings.
 *
 * ## How the shop UI uses it (the only integration surface)
 *
 *     const why = services.canBuy(item.effect.key);   // BEFORE charging; a string means "refuse, do not charge"
 *     if (why) { showRefusal(why); return; }
 *     ...shop.buy() + wallet deduction (the shop UI's job)...
 *     services.onPurchased(item.effect.key);           // AFTER charging: persists, plays the scene
 *
 * Keys the module does not know return null / do nothing, so the shop UI can call both
 * unconditionally for every purchase.
 *
 * ## What each scene is (the club is exterior-and-bouncer only: town LOTS has `enterable: false`)
 *
 * No interior exists to walk into, and building one is not this task, so the cabaret is played as a
 * full-screen neon vignette from the doorstep: the rope, the bouncer's opinion, then what is going
 * on behind the door. Rejected: toggling `enterable` (it would put the player in an empty box and
 * collide with the interiors work); a world-space rope animation (touches town/build.ts, which other
 * agents are editing, for a gain the vignette already delivers).
 *
 * Time stepping: the fade is driven by its own rAF loop with the dt clamped to 0.05 s per frame, the
 * same convention as the main loop, rather than by world.ts's frame (a contested file) or CSS
 * transitions (which run on wall-clock and cannot be stepped deterministically by a harness).
 */
import {
  SERVICE_KEYS, canBuy as canBuyPure, createServices, createSleepTimeline, isServiceKey, isTipsy,
  resolve, sanitizeServices, sleepOff, washOff, type Outcome, type ServicesState,
} from '@keysrun/shared/sim/services';
import type { Inventory } from '@keysrun/shared/sim/shop';
import './services.css';

const STORAGE_KEY = 'keysrun.services.v1';

/** SERVER SEAM: like the wallet (game/economy/system.ts), this is the player's own localStorage and
 * is not authoritative. Nothing here reaches a leaderboard. The scratch-off is seeded and its ticket
 * counter persisted, so a reload cannot re-roll a ticket, but a player who deletes the key gets a
 * fresh seed; money-bearing play would move this to the server with the wallet. */
function load(): ServicesState {
  const fresh = (): number => {
    try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; } catch { return (Date.now() ^ 0x5bd1e995) >>> 0; }
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeServices(JSON.parse(raw), fresh()) : createServices(fresh());
  } catch {
    return createServices(fresh());
  }
}
function save(s: ServicesState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* unremembered, not fatal */ }
}

export interface InventoryPort {
  get(): Inventory;
  set(next: Inventory): void;
  /** Simulated seconds, as shop.ts's buffs use. */
  nowS(): number;
}

export interface ServicesDeps {
  tod: { isSunset(): boolean; snapToSunset(): void };
  economy: { credit(n: number): void; flush(): void };
  toast(msg: string): void;
  boatName?(): string;
  /** TODO(shop agent): one line once the inventory accessor lands, e.g.
   *  `inventory: { get: () => shop.inventory, set: (i) => shop.setInventory(i), nowS: () => simTime }`.
   *  Without it the night and the wash still happen, they just do not clear drink buffs. */
  inventory?: InventoryPort;
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const GLYPH: Record<string, string> = { palm: '🌴', conch: '🐚', marlin: '🐟', sun: '☀️', anchor: '⚓', gull: '🕊️' };

export function createServicesSystem(deps: ServicesDeps) {
  let state = load();
  let sleeping = false;
  let dismiss: (() => void) | null = null;
  /** Verification only: cards stay up (no auto-dismiss), so a ~3 fps screenshot harness can catch them. */
  let holdCards = false;

  function layer(): HTMLElement {
    let l = $('svcLayer');
    if (!l) {
      l = document.createElement('div');
      l.id = 'svcLayer';
      l.innerHTML = '<div id="svcFade"></div><div id="svcCard" class="hidden"></div>';
      ($('wrap') ?? document.body).append(l);
    }
    return l;
  }

  function ctx() {
    const inv = deps.inventory;
    return {
      // A sleep in progress counts as sunset: it closes the double-click window in which a second
      // night could be bought while the first fade is still running.
      isSunset: deps.tod.isSunset() || sleeping,
      tipsy: inv ? isTipsy(inv.get(), inv.nowS()) : undefined,
      boatName: deps.boatName?.(),
    };
  }

  function canBuy(key: string): string | null {
    if (!isServiceKey(key)) return null;
    return canBuyPure(state, key, ctx());
  }

  /** Dismissable card: click, or any key, or after `ms`. */
  function showCard(cls: string, html: string, ms: number): void {
    layer();
    const c = $('svcCard')!;
    dismiss?.();
    c.className = `svc ${cls}`;
    c.innerHTML = html;
    let gone = false;
    const hide = (): void => {
      if (gone) return; gone = true; dismiss = null;
      c.classList.add('hidden');
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.code === 'Escape' || e.code === 'Space' || e.code === 'Enter') hide(); };
    const timer = holdCards ? 0 : setTimeout(hide, ms);
    c.onclick = hide;
    window.addEventListener('keydown', onKey, true);
    dismiss = hide;
  }

  const linesHtml = (lines: string[]): string =>
    lines.map((l, i) => `<p style="animation-delay:${(i * 0.9).toFixed(1)}s">${esc(l)}</p>`).join('');

  function playSleep(o: Outcome): void {
    sleeping = true;
    layer();
    const fade = $('svcFade')!;
    const card = $('svcCard')!;
    fade.classList.add('on');
    let shown = false;
    const tl = createSleepTimeline(() => {
      // Fully black: the only moment the sky may change.
      deps.tod.snapToSunset();
    });
    let last = performance.now();
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const r = tl.step(dt);
      fade.style.opacity = String(r.alpha);
      if (r.card && !shown) {
        shown = true;
        card.className = 'svc svc-room';
        card.innerHTML = `<h3>Sunset Motor Lodge</h3>${linesHtml(o.lines)}`;
      }
      if (!r.card && shown) { card.classList.add('hidden'); shown = false; }
      if (r.done) { fade.classList.remove('on'); fade.style.opacity = '0'; sleeping = false; deps.toast('Slept. It is sunset.'); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function playScratch(o: Outcome): void {
    const cells = (o.card?.cells ?? []).map((c, i) => `<div class="cell" style="animation-delay:${(0.5 + i * 0.35).toFixed(2)}s"><span>${GLYPH[c] ?? '?'}</span></div>`).join('');
    const win = (o.card?.prize ?? 0) > 0;
    showCard(`svc-scratch ${win ? 'win' : 'lose'}`,
      `<h3>Scratch &amp; Win</h3><div class="grid">${cells}</div><div class="result" style="animation-delay:3s">${win ? `$${o.card!.prize}` : 'No luck'}</div>${linesHtml(o.lines)}`, 12000);
  }

  function onPurchased(key: string): Outcome | null {
    if (!isServiceKey(key)) return null;
    const { state: next, outcome } = resolve(state, key, ctx());
    // Persist BEFORE any scene plays: closing the tab mid-animation must not undo the purchase or,
    // for the scratch-off, let the same ticket be bought again.
    state = next;
    save(state);

    const inv = deps.inventory;
    if (inv) {
      if (outcome.inventory === 'sleep') inv.set(sleepOff(inv.get()));
      else if (outcome.inventory === 'wash') inv.set(washOff(inv.get()));
    }
    if (outcome.payout > 0) deps.economy.credit(outcome.payout);
    if (outcome.fx === 'sleep') deps.economy.flush();

    switch (outcome.fx) {
      case 'sleep': playSleep(outcome); break;
      case 'scratch': playScratch(outcome); break;
      case 'rope':
      case 'sparkler':
      case 'spotlight':
        showCard(`svc-club ${outcome.fx}`, `<div class="neon">Pink Flamingo Cabaret</div><div class="beams"></div>${outcome.fx === 'sparkler' ? '<div class="sparks">' + '<i></i>'.repeat(14) + '</div>' : ''}${linesHtml(outcome.lines)}`, 9000);
        break;
      default:
        deps.toast(outcome.lines.join(' '));
    }
    return outcome;
  }

  return {
    get state() { return state; },
    keys: SERVICE_KEYS,
    canBuy,
    onPurchased,
    isBusy: () => sleeping,
    debugHoldCards(b: boolean): void { holdCards = b; },
    /** Dev/test only: the whole flow minus the shop UI and the wallet charge. Not reachable from play. */
    debugBuy(key: string): { refused: string | null; outcome: Outcome | null } {
      const refused = canBuy(key);
      return { refused, outcome: refused ? null : onPurchased(key) };
    },
  };
}

export type ServicesSystem = ReturnType<typeof createServicesSystem>;
