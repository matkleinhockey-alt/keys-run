/**
 * Treasure on the wrecks: the encrusted boxes in the sand, the reach prompt, and the one keypress
 * that empties one.
 *
 * Everything that decides anything is pure and shared — `@keysrun/shared/sim/treasure` owns where
 * the containers are, what each one pays, and the looted-set transition, and its header carries the
 * economy reasoning and the decision about where that state belongs. This file is the three.js and
 * the DOM: geometry, proximity, the prompt, the toast, and the two calls that move money.
 *
 * ## It follows the interaction model that already exists
 *
 * Ashore, `entities/land/**` shows a prompt for whatever is in reach (`town.nearestInteract` ->
 * `hud.setPrompt`) and F acts on it. This is the same verb, the same prompt format (`"F  Prise
 * open the strongbox"`, split on the double space into a `<kbd>`), the same "nothing in reach says
 * so out loud" behaviour — just with a 3D radius, because a diver can be 20 m above a strongbox.
 * Underwater F was free: the diver binds WASD/Space/Ctrl/Shift, the speargun binds R/S and the tap,
 * and land input is unbound while you are in the water. Nothing new was invented, and a player who
 * has been ashore once already knows the key.
 *
 * ## Cost model (same as entities/life/wrecks.ts, which this shadows)
 *
 * Nothing is paid for a wreck you are not near. Containers are built on first approach
 * (`BUILD_M`), 2 x ~150 triangles each (closed and open; see `buildContainer`'s header for why
 * both), and a wreck's whole set is one Group that is `visible = false` outside `BUILD_M`. In
 * practice at most one wreck is in range, so this is up to 5 extra draw calls while you are on a
 * hull and zero the rest of the time. No lights, for the reason wrecks.ts gives: three.js compiles
 * light count into every material in the world.
 *
 * Rejected: merging a wreck's containers into one geometry (1 draw call instead of 5). Opening one
 * would then mean rebuilding the merged mesh mid-dive, and the saving is 4 draw calls against a
 * budget of 300.
 */
import * as THREE from 'three';
import { wrecksFor, wreckEdgeDist, type Wreck } from '@keysrun/shared/world/wrecks';
import {
  containersFor, nearestUnopened, reachPrompt, stepOpenContainer, applyLoot, isOpened,
  lootOf, NOTICE_M, REACH_M, type Container, type ContainerKind, type TreasureState,
} from '@keysrun/shared/sim/treasure';
import type { GearPort } from '@keysrun/shared/sim/gear';
import { seafloorHeightAt } from '../../world/terrain/heightfield.js';
import { WORLD_SEED } from '../../state/constants.js';
import { buildContainer } from './wreck-geometry.js';
import { loadTreasure, saveTreasure } from './treasure-store.js';
import './wreck-treasure.css';

/** Build (and draw) a wreck's containers inside this many metres of the camera, measured from the
 * hull's edge. A little beyond wrecks.ts's own `FULL_M` (110) so the boxes are already there when
 * the detailed hull appears, rather than popping in a frame later. */
const BUILD_M = 130;
const HYST = 1.15;

/** Metres a container stands tall, by kind — what `Container.buried` is a fraction of. These are
 * `buildContainer`'s own geometry, and they have to stay in step with it: the coin spill's mound
 * is 0.13 m, and when this said 0.2 the sand swallowed the whole thing. */
const HEIGHT_M: Readonly<Record<ContainerKind, number>> = { strongbox: 0.62, coins: 0.13, crate: 0.6, ammocan: 0.36 };

interface Live {
  c: Container;
  root: THREE.Group;
  /** Closed and open geometry, both built, one visible. */
  shut: THREE.Object3D | null;
  open: THREE.Object3D | null;
}

interface LiveWreck {
  w: Wreck;
  group: THREE.Group;
  built: boolean;
  lives: Live[];
  shown: boolean;
}

export interface WreckTreasureDeps {
  scene: THREE.Scene;
  /** The rod/spear gear port (shared/sim/gear.ts) — how found ammo reaches the inventory. */
  gear: GearPort;
  /** Money in that is not a fish: `economy.credit` (game/economy/system.ts). */
  credit(cash: number): void;
  toast(msg: string): void;
  seed?: number;
}

export interface WreckTreasure {
  group: THREE.Group;
  /** Once a frame. `camera` decides what is built and drawn; `diver` (null when aboard) decides
   * the prompt and what F would open. */
  update(camera: { x: number; z: number }, diver: { x: number; y: number; z: number } | null): void;
  /** F while diving. True when something was actually opened. */
  tryOpen(): boolean;
  /** VERIFICATION-ONLY. */
  debug(): unknown;
  dispose(): void;
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export function createWreckTreasure(deps: WreckTreasureDeps): WreckTreasure {
  const seed = deps.seed ?? WORLD_SEED;
  const group = new THREE.Group();
  group.name = 'wreck-treasure';
  deps.scene.add(group);

  // One material for every container, same settings as the hulls': rough, barely metallic, vertex
  // coloured, flat shaded. DoubleSide because an open lid and the thin plank/coin geometry are
  // single-sided surfaces you can end up behind.
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.14, flatShading: true, side: THREE.DoubleSide });
  const geos: THREE.BufferGeometry[] = [];
  let state: TreasureState = loadTreasure();

  const wrecks = wrecksFor(seed);
  const liveWrecks: LiveWreck[] = wrecks.map((w) => {
    const g = new THREE.Group();
    g.name = `treasure:${w.id}`;
    g.visible = false;
    group.add(g);
    return { w, group: g, built: false, lives: [], shown: false };
  });

  // The prompt: its own element beside the diver HUD in index.html, built here rather than added
  // to the page, exactly as entities/land/hud.ts does for `#landPrompt` (whose look this shares).
  const promptEl = (() => {
    const found = $('lootPrompt');
    if (found) return found;
    const el = document.createElement('div');
    el.id = 'lootPrompt';
    el.className = 'hidden';
    ($('hud') ?? document.body).append(el);
    return el;
  })();
  // On a touch device there is no F: the diver's pad (`#touchDiver`) is seven swim buttons and
  // adding an eighth would crowd it for a verb you can only use twice a dive. The prompt itself is
  // the button instead — it is already exactly where a thumb is, and it only takes a tap while it
  // is the in-reach (yellow) one, so it can never act on something you are 9 m from.
  const onPromptTap = (e: Event): void => { e.preventDefault(); if (reach && reach.dist <= REACH_M) api.tryOpen(); };
  promptEl.addEventListener('click', onPromptTap);

  function meshFor(c: Container, open: boolean): THREE.Object3D | null {
    // The colour key is the container's index on its wreck plus the wreck's own index, so two
    // strongboxes are encrusted differently and the same one is identical every session.
    const i = Number(c.id.slice(c.id.lastIndexOf(':') + 1));
    const g = buildContainer(c.kind, open, i * 7 + 1.37);
    if (!g) return null;
    geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = false; m.receiveShadow = false;
    return m;
  }

  function build(L: LiveWreck): void {
    L.built = true;
    for (const c of containersFor(seed, L.w)) {
      const root = new THREE.Group();
      root.rotation.order = 'YXZ';
      // Sits on the seabed the terrain mesh actually draws (not the smooth `depthAt` floor), the
      // same sample wrecks.ts uses for its hulls and debris, sunk into the sand by `buried`.
      root.position.set(c.x, seafloorHeightAt(c.x, c.z) - c.buried * HEIGHT_M[c.kind], c.z);
      root.rotation.y = c.yaw;
      // Nothing on a seabed sits level after a century. Derived from the yaw rather than another
      // hash: it is cosmetic, and one fewer thing for the shared table to carry.
      root.rotation.z = Math.sin(c.yaw * 3.1) * 0.07;
      root.rotation.x = Math.cos(c.yaw * 2.3) * 0.05;
      const live: Live = { c, root, shut: meshFor(c, false), open: meshFor(c, true) };
      if (live.shut) root.add(live.shut);
      if (live.open) root.add(live.open);
      applyOpenState(live);
      L.group.add(root);
      L.lives.push(live);
    }
  }

  function applyOpenState(live: Live): void {
    const opened = isOpened(state, live.c.id);
    if (live.shut) live.shut.visible = !opened;
    if (live.open) live.open.visible = opened;
  }

  /** What F would act on right now, and what the prompt is describing. */
  let reach: { container: Container; wreck: Wreck; dist: number } | null = null;

  function setPrompt(text: string | null, near: boolean): void {
    promptEl.classList.toggle('hidden', !text);
    promptEl.classList.toggle('far', !!text && !near);
    promptEl.classList.toggle('tappable', !!text && near);
    if (!text) return;
    // Same `"KEY  text"` convention `entities/land/hud.ts` uses, so the two prompts look alike.
    const [k, ...rest] = text.split(/\s{2,}/);
    const html = rest.length ? `<kbd>${k}</kbd>${rest.join(' ')}` : k;
    if (promptEl.innerHTML !== html) promptEl.innerHTML = html;
  }

  const api: WreckTreasure = {
    group,

    update(camera, diver) {
      for (const L of liveWrecks) {
        const d = wreckEdgeDist(L.w, camera.x, camera.z);
        const at = L.shown ? BUILD_M * HYST : BUILD_M;
        const want = d <= at;
        if (want && !L.built) build(L);
        if (want !== L.shown) { L.group.visible = want; L.shown = want; }
      }
      if (!diver) {
        if (reach) { reach = null; setPrompt(null, false); }
        return;
      }
      // 20 containers in the whole world, so this is a flat scan rather than a spatial index;
      // `nearestUnopened` is pure and takes the terrain sampler so it can be unit tested.
      reach = nearestUnopened(seed, wrecks, state, diver.x, diver.y, diver.z, NOTICE_M, seafloorHeightAt);
      if (!reach) { setPrompt(null, false); return; }
      if (reach.dist <= REACH_M) setPrompt(reachPrompt(reach.container), true);
      else {
        // Out of reach but in sight: name it and say how far, which is the difference between
        // "there is treasure here somewhere" and 40 s of breath spent swimming the wrong way.
        const what = reach.container.kind === 'coins' ? 'Coins in the sand' : reach.container.kind === 'ammocan' ? 'An ammunition can' : reach.container.kind === 'crate' ? 'A cargo crate' : 'A strongbox';
        setPrompt(`${what}, ${Math.round(reach.dist)} m`, false);
      }
    },

    tryOpen() {
      if (!reach) { deps.toast('Nothing within reach down here.'); return false; }
      if (reach.dist > REACH_M) {
        deps.toast(`Too far — swim to it (${Math.round(reach.dist)} m).`);
        return false;
      }
      const { container, wreck } = reach;
      const r = stepOpenContainer(state, { seed, wreck, container });
      if (!r.loot) return false; // already emptied; the prompt should never have offered it
      state = r.state;
      saveTreasure(state);
      // Cash to the wallet, ammo to the inventory: the two existing seams, in that order, for the
      // reason game/economy/system.ts's `buyItem` gives about which failure a player forgives.
      deps.credit(r.loot.cash);
      if (r.loot.ammo > 0) deps.gear.commit(applyLoot(deps.gear.inventory(), r.loot));
      const money = '$' + r.loot.cash.toLocaleString('en-US');
      deps.toast(r.loot.ammo > 0
        ? `${r.loot.label} — ${money}, and ${r.loot.ammo} rounds for the console pistol.`
        : `${r.loot.label} — ${money}.`);
      for (const L of liveWrecks) for (const live of L.lives) if (live.c.id === container.id) applyOpenState(live);
      reach = null;
      setPrompt(null, false);
      return true;
    },

    debug() {
      return {
        opened: [...state.opened],
        reach: reach ? { id: reach.container.id, kind: reach.container.kind, dist: +reach.dist.toFixed(2) } : null,
        containers: wrecks.flatMap((w) => containersFor(seed, w).map((c) => ({
          id: c.id, kind: c.kind, x: +c.x.toFixed(1), z: +c.z.toFixed(1),
          y: +(seafloorHeightAt(c.x, c.z)).toFixed(1), opened: isOpened(state, c.id), ...lootOf(seed, w, c),
        }))),
      };
    },

    dispose() {
      deps.scene.remove(group);
      for (const g of geos) g.dispose();
      geos.length = 0;
      mat.dispose();
      promptEl.removeEventListener('click', onPromptTap);
      setPrompt(null, false);
    },
  };
  return api;
}
