/**
 * Ties a landed fish (from either rod fishing or the speargun) to scoring, the catch card, the
 * gin-pole hang rig / grip-and-grin photo (legacy index.html:2913-2944), and the cooler
 * keep/release choice. This is the one path both game/fishing and entities/speargun feed into —
 * see createCatchFlow's `landFish`.
 *
 * Session score/slam tracking here is a **client-local stand-in for a leaderboard, not a
 * leaderboard** — docs/ARCHITECTURE.md is explicit that the real leaderboard is reachable only
 * through server-generated catch rows (phase 3, a different agent's scope). Nothing here writes
 * anywhere persistent or calls a server.
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { SPECIES } from '@keysrun/shared/content/species';
import { VIS } from '@keysrun/shared/content/creatures';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { ZONE_DESC } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { clamp } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import { beamBetween } from '../../entities/boat/hull.js';
import { makeFishMesh } from '../fishing/fish-mesh.js';
import { createCooler, meatLine, type CoolerFish } from './cooler.js';
import { createPortrait } from './portrait.js';

function $(id: string): HTMLElement | null { return document.getElementById(id); }
function setText(id: string, s: string): void { const el = $(id); if (el) el.textContent = s; }

export interface CaughtFishInfo {
  key: string;
  weight: number;
  x: number;
  z: number;
  zone: string;
}

interface SessionStats {
  count: number;
  score: number;
  caught: Set<string>;
  best: { name: string; w: number; pts: number } | null;
  slam1: boolean;
  slam2: boolean;
}

interface PhotoHandle {
  fish: THREE.Object3D;
  parent: THREE.Object3D;
  hangGroup: THREE.Group | null;
  rig: THREE.Group | null;
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
  g.add(beamBetween(V(hx + 0.95, top, hz), V(hx + 0.95, hookY + 0.38, hz), 0.008, new THREE.MeshStandardMaterial({ color: 0x222222 })));
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

/** legacy `setupPhoto` (index.html:2920-2944), trimmed to the fish mesh itself: the
 * captain/crew-clearing and held-in-hands poses needed a real human model
 * (entities/boat/model.ts's `makeHumanStub` — out of scope, see that file's header), so a fish
 * too small for the gin pole rig just rests at the fishing spot instead of being held up. */
function setupPhoto(model: BoatModel, key: string, weight: number): PhotoHandle {
  const lenM = scaledLenM(key, weight);
  const fish = makeFishMesh(SPECIES[key].color, lenM);
  const deckY = model.fishSpot.y;
  if (weight >= 25 || lenM > 1.7) {
    const hx = model.fishSpot.x + 0.55, hz = model.fishSpot.z, fx = hx + 0.95;
    const hookY = deckY + clamp(lenM * 0.92, 2.3, 5.5);
    const rig = hangRig(model, deckY, hx, hz, hookY);
    fish.rotation.set(-Math.PI / 2, 0, 0);
    const hang = new THREE.Group();
    hang.position.set(fx, hookY, hz);
    fish.position.set(0, -lenM / 2, 0);
    hang.add(fish);
    model.group.add(hang);
    return { fish, parent: hang, hangGroup: hang, rig };
  }
  fish.rotation.set(0, Math.PI / 2, 0.12);
  fish.position.set(model.fishSpot.x, deckY + 0.3, model.fishSpot.z);
  model.group.add(fish);
  return { fish, parent: model.group, hangGroup: null, rig: null };
}

export interface CatchFlowDeps {
  scene: THREE.Scene;
  getModel(): BoatModel;
}

export function createCatchFlow(deps: CatchFlowDeps) {
  const session: SessionStats = { count: 0, score: 0, caught: new Set(), best: null, slam1: false, slam2: false };
  const cooler = createCooler();
  const portrait = createPortrait('fishCanvas');
  const released: ReleasedFish[] = [];

  let photo: PhotoHandle | null = null;
  let lastPts = 0;
  let lastStats: { inches: number; sex: string } | null = null;
  let current: CaughtFishInfo | null = null;
  let caughtAt = 0;

  function updateScore(): void {
    setText('scScore', session.score.toLocaleString());
    setText('scCount', String(session.count));
  }

  /** Called by game/fishing (rod) and entities/speargun with whatever fish they just landed —
   * the one shared path onto the catch card / cooler, per the task brief. */
  function landFish(fish: CaughtFishInfo, boat: BoatState): void {
    const model = deps.getModel();
    const S = SPECIES[fish.key];
    const pts = Math.round(fish.weight * S.mult);
    session.count++; session.score += pts; session.caught.add(fish.key);
    let bonus = '';
    if (!session.slam1 && ['tarpon', 'bonefish', 'permit'].every((k) => session.caught.has(k))) { session.slam1 = true; session.score += 1000; bonus = 'Inshore grand slam · +1,000'; }
    if (!session.slam2 && ['sailfish', 'mahi', 'wahoo'].every((k) => session.caught.has(k))) { session.slam2 = true; session.score += 1500; bonus = (bonus ? bonus + ' · ' : '') + 'Blue water slam · +1,500'; }
    if (!session.best || pts > session.best.pts) session.best = { name: S.name, w: fish.weight, pts };

    const fs = fishStats(fish.key, fish.weight);
    lastPts = pts; lastStats = fs; current = fish; caughtAt = performance.now();

    setText('cZone', `${ZONE_DESC[fish.zone] ?? fish.zone} · ${nearestName(fish.x, fish.z)}`);
    setText('cLen', `${fs.inches} in`);
    setText('cSex', fs.sex);
    setText('cName', S.name);
    setText('cWeight', fish.weight.toFixed(1));
    const priceEl = $('cPrice');
    const ml = meatLine(fish.key, fish.weight);
    if (priceEl) { priceEl.textContent = ml ? '💲 ' + ml : ''; priceEl.style.display = ml ? '' : 'none'; }
    setText('cPts', pts.toLocaleString());
    setText('cFact', S.fact);
    const bonusEl = $('cBonus');
    if (bonusEl) { bonusEl.textContent = bonus; bonusEl.classList.toggle('hidden', !bonus); }

    model.station = 0;
    model.fishSpot.copy(model.stations[0].spot);
    try { photo = setupPhoto(model, fish.key, fish.weight); portrait.show(S.color, scaledLenM(fish.key, fish.weight)); } catch (e) { console.error('photo setup', e); photo = null; }

    // legacy's `COOLER_CAP[boatSpec.id]||300` — boatId isn't threaded down to landFish's callers
    // (game/fishing, entities/speargun) today, so this always takes the `||300` fallback branch.
    // See cooler.ts's `prepareKeepChoice` / BoatModel's header for the integration seam.
    const choice = cooler.prepareKeepChoice('', fish.key, fish.weight);
    const keepBtn = $('btnKeep') as HTMLButtonElement | null;
    if (keepBtn) keepBtn.disabled = choice.disabled;
    setText('cNote', choice.note);

    $('card')?.classList.remove('hidden');
    document.body.classList.add('photoing');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    updateScore();
  }

  // boatId isn't passed down to landFish's caller today (game/fishing and entities/speargun
  // don't track which boat spec is active) — COOLER_CAP falls back to 300 when unknown, same as
  // legacy's `COOLER_CAP[boatSpec.id]||300`. See BoatModel's header for the integration seam if
  // a later phase wants the exact per-boat cap honored here too.
  function boatIdOf(_model: BoatModel): string { return ''; }

  function finishCatch(): void {
    if (photo?.rig?.parent) photo.rig.parent.remove(photo.rig);
    if (photo?.hangGroup?.parent) photo.hangGroup.parent.remove(photo.hangGroup);
    $('card')?.classList.add('hidden');
    document.body.classList.remove('photoing');
    if (photo?.fish && photo.fish.parent) photo.parent.remove(photo.fish);
    portrait.clear();
    photo = null;
    current = null;
  }

  function keepFish(): void {
    if (!current || performance.now() - caughtAt < 600) return;
    const keepBtn = $('btnKeep') as HTMLButtonElement | null;
    if (keepBtn?.disabled) return;
    const S = SPECIES[current.key];
    const fish: CoolerFish = { name: S.name, key: current.key, weight: current.weight, inches: lastStats!.inches, sex: lastStats!.sex, pts: lastPts };
    cooler.keepFish(fish);
    toast(`${S.name} is on ice. ${cooler.cooler.length} fish in the cooler.`);
    finishCatch();
  }

  function releaseFish(): void {
    if (!current || performance.now() - caughtAt < 600) return;
    const bonus = Math.round(lastPts * 0.25);
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
    }
    toast('Released! +' + bonus + ' conservation bonus.');
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

  function renderPortrait(t: number, renderer: THREE.WebGLRenderer): void {
    portrait.render(renderer, t);
  }

  return {
    session, cooler, landFish, finishCatch, keepFish, releaseFish, updateReleased, renderPortrait, updateScore,
    get current() { return current; },
  };
}
