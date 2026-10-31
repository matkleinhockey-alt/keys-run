/**
 * Ties a landed fish (from either rod fishing or the speargun) to scoring, the catch card, the
 * gin-pole hang rig / grip-and-grin photo (legacy index.html:2913-2944), and the cooler
 * keep/release choice. This is the one path both game/fishing and entities/speargun feed into —
 * see createCatchFlow's `landFish`.
 *
 * Session score/slam tracking here is a client-local stand-in for competitive scoring — it always
 * runs, online or offline, and is never gated on the server call below. `landFish` also reports
 * the catch to apps/api via ui/leaderboard/submit-catch.ts's `submitCatch`, which is a no-op when
 * offline/logged out and never throws — see that module's header and apps/api/src/routes/
 * catches.ts's doc comment for the honesty tradeoff that write is a deliberate, documented interim
 * step short of real server authority (docs/ARCHITECTURE.md phase 3).
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { SPECIES, BILLFISH } from '@keysrun/shared/content/species';
import { SPEED_SCALE } from '@keysrun/shared/content/boats';
import { VIS } from '@keysrun/shared/content/creatures';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { ZONE_DESC } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { clamp } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import { submitCatch } from '../../ui/leaderboard/submit-catch.js';
import { ocean } from '../../net/ocean.js';
import { catchPressure } from '@keysrun/shared/sim/ocean';
import { beamBetween } from '../../entities/boat/hull.js';
import { makeFishMesh } from '../fishing/fish-mesh.js';
import { buildPulleyBlock } from './pulley.js';
import { isHoldable } from './display-mode.js';
import type { GearPort } from '@keysrun/shared/sim/gear';
import { createCooler, meatLine, nearMarina, type CoolerFish } from './cooler.js';
import { createPortrait } from './portrait.js';
import type { Backdrop } from './render-pipeline.js';
import { createUnderwaterTrophy } from './underwater-trophy.js';
import { RECAPTURE_RELEASE_BONUS, TAG_RELEASE_BONUS } from '@keysrun/shared/sim/tagging';
import { createTagRegistry, describeTag, type TaggedFish } from './tags.js';
import { placeHoldingCaptain, placePresentingCaptain, type DeckCaptainHandle } from './deck-figure.js';

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function setText(id: string, s: string): void { const el = $(id); if (el) el.textContent = s; }

export interface CaughtFishInfo {
  key: string;
  weight: number;
  x: number;
  z: number;
  zone: string;
  /** Landed by the portrait debug hook rather than by fishing, so it has no real position (it
   * passes 0,0) and must not touch the ocean ledger — a screenshot script iterating fifty species
   * would otherwise pile fifty catches of pressure onto the chunk at the world origin, on a real
   * signed-in account. Normal play never sets this. */
  synthetic?: boolean;
  /** Which path landed it — rod fishing (the default, boat-deck grip-and-grin/gin-pole photo) or
   * the speargun (the underwater grip-and-grin, see underwater-trophy.ts). Optional/defaults to
   * 'rod' so game/fishing's existing call site (which predates this field) needs no change. */
  source?: 'rod' | 'spear';
  /** Landed off a pier or a dock (game/fishing/shore.ts), standing here: the card's portrait at a
   * pier railing, but no grip-and-grin on the boat's deck — the boat is tied up somewhere behind
   * you, and the captain posing with your fish on it would be a photo of someone else's catch. */
  ashore?: { x: number; z: number } | null;
  /** Set when the rod hooked a tagged individual (game/catch/tags.ts) — the card then shows its
   * history, and keeping or releasing it is reported back to the tag registry. */
  tag?: TaggedFish | null;
}

interface SessionStats {
  count: number;
  score: number;
  caught: Set<string>;
  best: { name: string; w: number; pts: number } | null;
  slam1: boolean;
  slam2: boolean;
  /** Heaviest fish landed this run (by weight, not points) — hung on the dock when you go ashore
   * (entities/land/dock-celebration.ts). `id` is the landing's number, so the same fish is only
   * celebrated once. */
  biggest: { key: string; weight: number; id: number; released: boolean } | null;
}

interface PhotoHandle {
  fish: THREE.Object3D;
  parent: THREE.Object3D;
  hangGroup: THREE.Group | null;
  rig: THREE.Group | null;
  /** The captain standing on deck with the catch (deck-figure.ts) — present on both branches of
   * `setupPhoto` now, see that function's updated doc comment. */
  captain: DeckCaptainHandle | null;
}

interface ReleasedFish { m: THREE.Object3D; t: number; dx: number; dz: number }

/** legacy `fishStats` (index.html:2867-2875). */
function fishStats(key: string, weight: number): { inches: number; sex: string } {
  const S = SPECIES[key];
  const sizeT = (weight - S.min) / (S.max - S.min);
  const avgW = (S.min + S.max) / 2;
  const Lm = VIS[key].len * Math.cbrt(weight / avgW) * 1.1;
  let female: boolean;
  if (['marlin', 'blackmarlin', 'sailfish', 'swordfish', 'tarpon', 'permit', 'snook'].includes(key)) female = Math.random() < 0.45 + sizeT * 0.5;
  else if (['grouper', 'hogfish'].includes(key)) female = Math.random() > 0.2 + sizeT * 0.7;
  else female = Math.random() < 0.5;
  let sex = female ? 'Female' : 'Male';
  if (key === 'mahi') sex = female ? 'Cow' : 'Bull';
  return { inches: Math.round(Lm * 39.37), sex };
}

/** Species whose body reads better near-profile than at the portrait's default three-quarter
 * angle (game/catch/portrait.ts's `show` elongated param) — billfish plus a couple of other
 * long/thin-bodied species the brief called out by name. */
const ELONGATED_SPECIES = new Set<string>([...BILLFISH, 'barracuda', 'wahoo']);

function nearestName(x: number, z: number): string {
  const s = shoreInfo(x, z);
  return (s.d < 120 ? 'off ' : 'toward ') + (s.isl ? s.isl.name : '');
}

/** legacy `hangRig` (index.html:2914-2919): a gin pole off the gunwale with a hanging scale,
 * for a fish too big to hold up. */
function hangRig(model: BoatModel, deckY: number, hx: number, hz: number, hookY: number): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.85, roughness: 0.25 });
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const top = hookY + 0.9;
  g.add(beamBetween(V(hx, deckY, hz), V(hx, top, hz), 0.045, steel));
  g.add(beamBetween(V(hx, top, hz), V(hx + 0.95, top + 0.05, hz), 0.035, steel));
  g.add(beamBetween(V(hx, top - 0.6, hz), V(hx + 0.6, top, hz), 0.025, steel));
  // Block at the boom head the lifting line runs over — see game/catch/pulley.ts. Without it the
  // cable started in mid-air at the tip, which reads as a bent pipe rather than a hoist you could
  // crank a 600 lb fish up with.
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const sheaveR = 0.11;
  const block = buildPulleyBlock({ radius: sheaveR });
  block.position.set(hx + 0.95, top - sheaveR * 1.15, hz);
  g.add(block);
  // Hauling part back along the boom to the post, then the hanging part down to the scale.
  g.add(beamBetween(V(hx + 0.95 - sheaveR, top - sheaveR * 1.15, hz), V(hx, top - 0.5, hz), 0.007, cableMat));
  g.add(beamBetween(V(hx + 0.95 + sheaveR, top - sheaveR * 1.15, hz), V(hx + 0.95, hookY + 0.38, hz), 0.008, cableMat));
  const sc = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 20), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 }));
  sc.rotation.z = Math.PI / 2; sc.position.set(hx + 0.95, hookY + 0.27, hz);
  g.add(sc);
  const dial = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), new THREE.MeshBasicMaterial({ color: 0xf4f4f2 }));
  dial.position.set(hx + 0.977, hookY + 0.27, hz); dial.rotation.y = Math.PI / 2;
  g.add(dial);
  g.add(beamBetween(V(hx + 0.95, hookY + 0.2, hz), V(hx + 0.95, hookY, hz), 0.01, steel));
  model.group.add(g);
  return g;
}

/** legacy `setupPhoto` (index.html:2920-2944). Both branches now also put the captain on deck
 * with the catch (game/catch/deck-figure.ts) — see that module's header for why it's a separate
 * file (figure.ts's captain bust has no legs, built for the catch card's cropped frame) and why
 * the big-fish branch presents beside the crane rather than gripping the hanging fish. */
function setupPhoto(model: BoatModel, key: string, weight: number): PhotoHandle {
  const lenM = scaledLenM(key, weight);
  const fish = makeFishMesh(SPECIES[key].color, lenM);
  const deckY = model.fishSpot.y;
  // Same rule the catch card uses — see display-mode.ts. These used to be two different
  // thresholds, so a 25 lb mahi hung from the pole on deck while the card showed it held.
  if (!isHoldable(lenM, weight)) {
    const hx = model.fishSpot.x + 0.55, hz = model.fishSpot.z, fx = hx + 0.95;
    const hookY = deckY + clamp(lenM * 0.92, 2.3, 5.5);
    const rig = hangRig(model, deckY, hx, hz, hookY);
    fish.rotation.set(-Math.PI / 2, 0, 0);
    const hang = new THREE.Group();
    hang.position.set(fx, hookY, hz);
    fish.position.set(0, -lenM / 2, 0);
    hang.add(fish);
    model.group.add(hang);
    const captain = placePresentingCaptain(model, deckY);
    model.group.add(captain.group);
    return { fish, parent: hang, hangGroup: hang, rig, captain };
  }
  const captain = placeHoldingCaptain(model, deckY, fish);
  model.group.add(captain.group);
  return { fish, parent: captain.group, hangGroup: null, rig: null, captain };
}

/** Legacy `boatSpec.id`/`.brand`/`.name` — just enough of the active boat's identity for the
 * cooler (its capacity is per-boat, legacy `COOLER_CAP[boatSpec.id]`) and the cooler panel's
 * header. Neither rod fishing nor spearfishing needs the boat's live position/speed for any of
 * this — only `weighIn` below does, and it takes a `BoatState` directly for that. */
export interface BoatSpecRef {
  id: string;
  brand: string;
  name: string;
}

export interface CatchFlowDeps {
  /** Called once the catch card has been fully dismissed (kept, released, or the dive card
   * closed). The rod's state machine needs this to leave `'caught'` — see `finishCatch`. */
  onCatchFinished?(): void;
  scene: THREE.Scene;
  getModel(): BoatModel;
  getBoatSpec(): BoatSpecRef;
  /** Pays the player for a landed fish (game/economy/system.ts). Optional so harnesses that build
   * a catch flow without a wallet still work. Called from `landFish` — the one path rod and spear
   * both take — so every landing pays exactly once, whichever tool landed it. */
  /** Player inventory — only the cooler reads it (bagged ice). Omitted = no ice, base capacity. */
  gear?: GearPort;
  economy?: { payForCatch(key: string, weight: number): { value: number; trophy: boolean; personalBest: boolean } };
  /** A fish went in the cooler (game/tournament: a kept fish is one you can bring in). */
  onKeep?(key: string, weight: number): void;
}

export function createCatchFlow(deps: CatchFlowDeps) {
  const session: SessionStats = { count: 0, score: 0, caught: new Set(), best: null, slam1: false, slam2: false, biggest: null };
  const cooler = createCooler(deps.gear);
  const portrait = createPortrait('fishCanvas');
  // Shares `#fishCanvas` with `portrait` — see underwater-trophy.ts's header: only one of the two
  // is ever "shown" at a time (a rod catch and a speared catch can't both be the current catch).
  const trophy = createUnderwaterTrophy('fishCanvas');
  const released: ReleasedFish[] = [];
  const tags = createTagRegistry();

  let photo: PhotoHandle | null = null;
  let lastPts = 0;
  let lastStats: { inches: number; sex: string } | null = null;
  let current: CaughtFishInfo | null = null;
  /** Which card is live — drives `renderPortrait`/`finishCatch`'s branching. Mirrors `current`:
   * meaningful only while `current` is non-null. */
  let currentSource: 'rod' | 'spear' = 'rod';
  let caughtAt = 0;

  function updateScore(): void {
    setText('scScore', session.score.toLocaleString());
    setText('scCount', String(session.count));
  }

  /** Called by game/fishing (rod) and entities/speargun with whatever fish they just landed —
   * the one shared path onto the catch card / cooler, per the task brief. Deliberately takes no
   * `BoatState`: a speared fish is landed by a swimming diver, who may be nowhere near the boat,
   * so this only ever needs the boat's *identity* (`getBoatSpec`), never its position. */
  function landFish(fish: CaughtFishInfo): void {
    const model = deps.getModel();
    const boatSpec = deps.getBoatSpec();
    const S = SPECIES[fish.key];
    const pts = Math.round(fish.weight * S.mult);
    session.count++; session.score += pts; session.caught.add(fish.key);
    let bonus = '';
    if (!session.slam1 && ['tarpon', 'bonefish', 'permit'].every((k) => session.caught.has(k))) { session.slam1 = true; session.score += 1000; bonus = 'Inshore grand slam · +1,000'; }
    if (!session.slam2 && ['sailfish', 'mahi', 'wahoo'].every((k) => session.caught.has(k))) { session.slam2 = true; session.score += 1500; bonus = (bonus ? bonus + ' · ' : '') + 'Blue water slam · +1,500'; }
    if (!session.best || pts > session.best.pts) session.best = { name: S.name, w: fish.weight, pts };
    if (!session.biggest || fish.weight > session.biggest.weight) session.biggest = { key: fish.key, weight: fish.weight, id: session.count, released: false };

    // Fire-and-forget report to the real leaderboard (apps/api). Wrapped defensively even though
    // submitCatch itself never throws (see its own header) — nothing downstream of a landed fish
    // may ever be allowed to break the catch card or the frame loop over this.
    try { submitCatch(fish.key, fish.weight); } catch (e) { console.error('submitCatch', e); }
    // The water remembers: this chunk is now fished a little harder (net/ocean.ts; a no-op
    // offline). Weighted by the fish, so a trophy costs the spot more than a schoolie, against
    // its own species' range — a median fish is worth 1 and leaves the tuning where it was.
    if (!fish.synthetic) {
      try {
        const def = SPECIES[fish.key];
        ocean.recordCatch(fish.x, fish.z, def ? catchPressure(fish.weight, def.min, def.max) : 1);
      } catch (e) { console.error('ocean.recordCatch', e); }
    }

    // Paid on landing, before keep/release: see sim/economy.ts's `stepCatch` for why. Wrapped for
    // the same reason as submitCatch above.
    let cashLine = '';
    try {
      const pay = deps.economy?.payForCatch(fish.key, fish.weight);
      if (pay && pay.value > 0) {
        cashLine = `+$${pay.value.toLocaleString('en-US')}` + (pay.trophy ? ' · trophy' : '') + (pay.personalBest ? ' · personal best' : '');
      }
    } catch (e) { console.error('economy', e); }

    const fs = fishStats(fish.key, fish.weight);
    lastPts = pts; lastStats = fs; current = fish; caughtAt = performance.now();
    currentSource = fish.source === 'spear' ? 'spear' : 'rod';

    setText('cZone', `${ZONE_DESC[fish.zone] ?? fish.zone} · ${nearestName(fish.x, fish.z)}`);
    setText('cLen', `${fs.inches} in`);
    setText('cSex', fs.sex);
    setText('cName', S.name);
    setText('cWeight', fish.weight.toFixed(1));
    const priceEl = $('cPrice');
    const ml = meatLine(fish.key, fish.weight);
    if (priceEl) { priceEl.textContent = ml ? '💲 ' + ml : ''; priceEl.style.display = ml ? '' : 'none'; }
    setText('cPts', pts.toLocaleString());
    setText('cCash', cashLine);
    setText('cFact', S.fact);
    const bonusEl = $('cBonus');
    if (bonusEl) { bonusEl.textContent = bonus; bonusEl.classList.toggle('hidden', !bonus); }
    setText('cBadge', currentSource === 'spear' ? '🔱 Speared underwater' : '');

    if (currentSource === 'spear') {
      // No boat prop involved — a speared fish is landed wherever the diver was, possibly nowhere
      // near the boat (this function deliberately takes no `BoatState`, see its own header note).
      photo = null;
      try { trophy.show(S.color, scaledLenM(fish.key, fish.weight)); } catch (e) { console.error('trophy setup', e); }
    } else if (fish.ashore) {
      photo = null;
      try { portrait.show(S.color, scaledLenM(fish.key, fish.weight), ELONGATED_SPECIES.has(fish.key), fish.weight, 'dock'); } catch (e) { console.error('portrait setup', e); }
    } else {
      model.station = 0;
      model.fishSpot.copy(model.stations[0].spot);
      try { photo = setupPhoto(model, fish.key, fish.weight); portrait.show(S.color, scaledLenM(fish.key, fish.weight), ELONGATED_SPECIES.has(fish.key), fish.weight); } catch (e) { console.error('photo setup', e); photo = null; }
    }

    const choice = cooler.prepareKeepChoice(boatSpec.id, fish.key, fish.weight);
    const keepBtn = $('btnKeep') as HTMLButtonElement | null;
    if (keepBtn) keepBtn.disabled = choice.disabled;
    setText('cNote', choice.note);
    showTagInfo(fish);

    $('card')?.classList.remove('hidden');
    $('card')?.classList.toggle('dive', currentSource === 'spear');
    document.body.classList.add('photoing');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    updateScore();
  }

  /** The tag block and the tag-specific buttons: a recaptured fish shows its history and its
   * Release becomes "release & report"; an untagged rod catch offers Tag & release (a speared fish
   * is dead, so it can't be tagged). */
  function showTagInfo(fish: CaughtFishInfo): void {
    const tagEl = $('cTag');
    if (tagEl) {
      tagEl.replaceChildren();
      if (fish.tag) {
        const { headline, lines } = describeTag(fish.tag);
        const h = document.createElement('b');
        h.textContent = headline;
        const ul = document.createElement('ul');
        for (const line of lines) { const li = document.createElement('li'); li.textContent = line; ul.append(li); }
        tagEl.append(h, ul);
      }
      tagEl.classList.toggle('hidden', !fish.tag);
    }
    const tagBtn = $('btnTag');
    if (tagBtn) {
      tagBtn.classList.toggle('hidden', !!fish.tag || fish.source === 'spear');
      // A fish you can't keep (CR_ONLY, or no cooler room) makes tagging the headline choice.
      tagBtn.classList.toggle('alt', !($('btnKeep') as HTMLButtonElement | null)?.disabled);
    }
    setText('btnRelease', fish.tag ? 'Release & report tag' : 'Release');
    if (fish.tag && !($('btnKeep') as HTMLButtonElement | null)?.disabled) {
      setText('cNote', `Keeping it retires tag ${fish.tag.code}; releasing it reports the recapture and lets it keep growing.`);
    }
  }

  function finishCatch(): void {
    $('card')?.classList.remove('dive');
    trophy.clear();
    if (photo?.rig?.parent) photo.rig.parent.remove(photo.rig);
    if (photo?.hangGroup?.parent) photo.hangGroup.parent.remove(photo.hangGroup);
    if (photo?.captain) {
      if (photo.captain.group.parent) photo.captain.group.parent.remove(photo.captain.group);
      photo.captain.dispose();
    }
    $('card')?.classList.add('hidden');
    document.body.classList.remove('photoing');
    if (photo?.fish && photo.fish.parent) photo.parent.remove(photo.fish);
    portrait.clear();
    photo = null;
    current = null;
    // The rod's state machine parks in 'caught' when a fish lands and nothing else ever brings it
    // back — see fishing/update.ts's `clearCaught`. Fired here, at the single point every exit
    // from the card funnels through (keep, release, and the dive-card path), rather than wired to
    // each button separately, so a future fourth exit cannot forget it.
    deps.onCatchFinished?.();
  }

  function keepFish(): void {
    if (!current || performance.now() - caughtAt < 600) return;
    const keepBtn = $('btnKeep') as HTMLButtonElement | null;
    if (keepBtn?.disabled) return;
    const S = SPECIES[current.key];
    const fish: CoolerFish = { name: S.name, key: current.key, weight: current.weight, inches: lastStats!.inches, sex: lastStats!.sex, pts: lastPts };
    cooler.keepFish(fish);
    toast(`${S.name} is on ice. ${cooler.cooler.length} fish in the cooler.`);
    try { deps.onKeep?.(current.key, current.weight); } catch (e) { console.error('onKeep', e); }
    if (current.tag) {
      const code = current.tag.code;
      void tags.reportLanded(current.tag, landing(current), true).then((t) => {
        if (t) toast(`Tag ${code} reported — that fish's story ends in your cooler.`);
      });
    }
    finishCatch();
  }

  function landing(fish: CaughtFishInfo): { x: number; z: number; zone: string } {
    return { x: fish.x, z: fish.z, zone: fish.zone };
  }

  /** Release, reporting the recapture if it carries a tag. */
  function releaseFish(): void {
    if (!current || performance.now() - caughtAt < 600) return;
    if (!current.tag) { releaseWith(0.25, (b) => `Released! +${b} conservation bonus.`); return; }
    const code = current.tag.code;
    void tags.reportLanded(current.tag, landing(current), false).then((t) => {
      if (t) toast(`Recapture of ${code} logged — ${t.events.length} landings on record.`);
    });
    releaseWith(RECAPTURE_RELEASE_BONUS, (b) => `Released ${code} again! +${b} tag-report bonus.`);
  }

  /** Put a fresh tag in an untagged rod catch and let it go. It joins the shared registry, keeps
   * growing, and anyone who hooks it later sees that you tagged it. */
  function tagAndRelease(): void {
    if (!current || performance.now() - caughtAt < 600) return;
    if (current.tag || currentSource === 'spear') return;
    const name = SPECIES[current.key].name;
    void tags.tagAndRelease(current.key, current.weight, landing(current)).then((t) => {
      toast(t ? `Tag ${t.code} is swimming. You'll hear about it if anyone lands that ${name}.` : 'Couldn’t log the tag — the fish was still released.');
    });
    releaseWith(TAG_RELEASE_BONUS, (b) => `Tagged and released! +${b} conservation bonus.`);
  }

  function releaseWith(bonusFrac: number, message: (bonus: number) => string): void {
    if (session.biggest?.id === session.count) session.biggest.released = true;
    const bonus = Math.round(lastPts * bonusFrac);
    session.score += bonus;
    updateScore();
    if (photo?.fish) {
      const f = photo.fish;
      const world = new THREE.Vector3();
      f.getWorldPosition(world);
      photo.parent.remove(f);
      deps.scene.add(f);
      f.position.copy(world);
      f.position.y = Math.min(f.position.y, 0);
      f.rotation.set(0, 0, 0);
      if (photo.hangGroup?.parent) photo.hangGroup.parent.remove(photo.hangGroup);
      const model = deps.getModel();
      const a = Math.atan2(model.group.position.x - world.x, model.group.position.z - world.z) + Math.PI;
      released.push({ m: f, t: 0, dx: Math.sin(a), dz: Math.cos(a) });
      // `f` now lives directly in the scene, not under `photo.parent` — finishCatch's
      // `photo.parent.remove(photo.fish)` becomes a harmless no-op (three.js `remove()` on a
      // non-child is a silent no-op) rather than double-handling it, so `photo` is left as-is.
    } else if (current?.ashore) {
      // Off a pier there is no deck photo to take the fish from, so it goes back where it was
      // landed — in the water at the angler's feet — and swims off away from them, through the
      // same animation a boat release uses.
      const S = SPECIES[current.key];
      const f = makeFishMesh(S.color, scaledLenM(current.key, current.weight));
      f.position.set(current.x, 0, current.z);
      deps.scene.add(f);
      const a = Math.atan2(current.x - current.ashore.x, current.z - current.ashore.z);
      released.push({ m: f, t: 0, dx: Math.sin(a), dz: Math.cos(a) });
    }
    toast(message(bonus));
    finishCatch();
  }

  function updateReleased(dt: number, t: number, waveHeight: (x: number, z: number, t: number) => number): void {
    for (let i = released.length - 1; i >= 0; i--) {
      const r = released[i];
      r.t += dt;
      const m = r.m;
      const surf = waveHeight(m.position.x, m.position.z, t);
      if (r.t < 0.6) {
        m.position.y += (surf - 0.2 - m.position.y) * Math.min(1, dt * 6);
      } else {
        m.position.x += r.dx * 3.5 * dt;
        m.position.z += r.dz * 3.5 * dt;
        m.position.y += (surf - 1.2 - r.t * 0.3 - m.position.y) * Math.min(1, dt * 2);
        m.rotation.set(0, Math.atan2(-r.dx, -r.dz) + Math.sin(t * 12) * 0.15, 0, 'YXZ');
      }
      if (r.t > 4.5) { deps.scene.remove(m); released.splice(i, 1); }
    }
  }

  function renderPortrait(t: number, renderer: THREE.WebGLRenderer, behind?: Backdrop): void {
    if (currentSource === 'spear') trophy.render(renderer, t);
    else portrait.render(renderer, t, behind);
  }

  /** legacy `openCooler()` (index.html:2996-3002), supplying the active boat's identity. */
  function openCoolerPanel(): void {
    const spec = deps.getBoatSpec();
    cooler.openCooler(spec.brand, spec.name, spec.id);
  }

  /** legacy's `KeyE` handler (index.html:4088) plus `weighIn(M)` (2963-3009): find a dockside
   * marina within range, gate on speed same as legacy, and apply the cooler's bonus to the
   * session score. */
  function weighIn(boat: BoatState): void {
    const marina = nearMarina(boat.x, boat.z);
    if (!marina) return;
    if (Math.abs(boat.speed) > 2.5) { toast('Slow down to tie up at the dock.'); return; }
    const result = cooler.weighIn(marina.name);
    if (!result) { toast('Your cooler is empty — go catch something to weigh in.'); return; }
    session.score += result.bonus;
    updateScore();
    toast(result.summary);
  }

  /** legacy's `tDock` visibility toggle (index.html:3761): only worth showing the touch "weigh
   * in" button when there's something to weigh in, in range, and the boat is slow enough to tie
   * up. */
  function updateTouchDock(boat: BoatState): void {
    const el = $('tDock');
    if (!el) return;
    const kn = Math.abs(boat.speed) / SPEED_SCALE / 0.5144;
    const canDock = !!nearMarina(boat.x, boat.z) && cooler.cooler.length > 0 && kn < 5;
    el.classList.toggle('hidden', !canDock);
  }

  // DEV/VERIFICATION HOOK ONLY (game/catch/portrait.ts's iteration note, same spirit as game/
  // world.ts's __fishDebug/__diverDebug) — lands an arbitrary species/weight instantly and lets
  // a script step the portrait's own render loop directly, so a screenshot script can iterate on
  // the catch-card photo across many species without playing out a real multi-minute cast ->
  // fight -> land at this sandbox's software-WebGL frame rate. Reads game/world.ts's
  // `window.__renderer` rather than taking a renderer param — a script can't pass a live
  // `THREE.WebGLRenderer` instance across `page.evaluate`'s serialization boundary. No normal
  // code path reads `window.__catchPortraitDebug`.
  (window as unknown as { __catchPortraitDebug?: unknown }).__catchPortraitDebug = {
    land(key: string, weight: number, tag?: TaggedFish): void { landFish({ key, weight, x: 0, z: 0, zone: 'Reef', tag, synthetic: true }); },
    /** Same idea, for the underwater trophy card (underwater-trophy.ts) — `source: 'spear'`
     * routes `landFish` to `trophy.show` instead of the boat-deck photo. */
    landSpeared(key: string, weight: number): void { landFish({ key, weight, x: 0, z: 0, zone: 'Reef', source: 'spear', synthetic: true }); },
    renderFrame(t: number): void {
      const renderer = (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer;
      if (renderer) renderPortrait(t, renderer);
    },
  };

  return {
    session, cooler, tags, landFish, finishCatch, keepFish, releaseFish, tagAndRelease, updateReleased, renderPortrait, updateScore,
    openCoolerPanel, weighIn, updateTouchDock,
    get current() { return current; },
  };
}
