/**
 * Land mode, as game/world.ts sees it: a third peer beside the boat and the diver, wired in through
 * one object so the world's own file only has to ask a handful of questions of it.
 *
 * ## Why a facade
 * Four agents are editing game/world.ts in parallel, and a mode that needs the scene, the camera,
 * the boat state, the HUD and the fishing state machine would otherwise smear itself across a
 * hundred lines of it. Everything mode-shaped lives here instead, and world.ts touches it at seven
 * points (listed in the integration notes at the bottom of this header's commit): construct it, pass
 * it neutral input and pin the boat while ashore, step it in the fixed loop, run its mode-change
 * handler after that loop, hand it the camera, update it once per frame, and ask it before diving.
 *
 * ## The mode-change discipline (same as the diver's, deliberately)
 * Mode flips happen in exactly one place, `syncMode()`, called once per frame after the fixed-step
 * loop — never inside a key handler — so there is a single spot that saves and restores things:
 *   - the boat camera's drift (`camState`, `fpState`): entities/camera.ts's pointer binding is
 *     mode-agnostic and keeps mutating them while you drag-look ashore, so they are snapshotted on
 *     entry and put back on exit, along with `camera.near/far/fov`;
 *   - the boat HUD (gauges, chart, scorebox, touch pad) hidden on entry, restored on exit;
 *   - the land HUD, body, mooring line;
 *   - and the boat itself, pinned to its mooring by `holdBoat` for as long as you are ashore.
 * The involuntary exits (`btnMarina`, the net agent switching hulls) go through `exitToBoat()` and
 * the same `syncMode()` picks them up, so no path can skip the restore.
 *
 * ## The one thing to remember when reading this
 * Entering requires the boat to be alongside a dock and nearly stopped. That check is `canTieUp`
 * (pure, in controller.ts); the HUD's "F  Tie up and go ashore" prompt and the key handler both ask
 * it, so they cannot disagree.
 */
import * as THREE from 'three';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { DECK_TOP, PAD, PAD_Y, SURFACES, TOWN_FRAME, LOTS, toLocal, toWorld, COLLIDERS, groundAt } from '@keysrun/shared/world/town';
import { VENUES } from '@keysrun/shared/content/venues';
import { buy, emptyInventory } from '@keysrun/shared/sim/shop';
import { CASINO_LOT } from '@keysrun/shared/world/casino';
import type { LightMatEntry } from '../../core/time-of-day.js';
import type { BoatModel } from '../boat/model.js';
import type { CamState, FpState } from '../camera.js';
import { makeHuman, type Human } from '../life/human.js';
import { createOutfitSync, wardrobe } from '../life/outfit.js';
import { createTown, type Town } from '../town/town.js';
import { animateGait } from '../town/people.js';
import { createLandController, type LandController, type LandMode, type WalkableEstate } from './controller.js';
import { updateLandCamera, cycleLandView } from './camera.js';
import type { ShopPort } from '../../ui/gear.js';
import { createLandHud, type LandHudHandles } from './hud.js';
import { createDockCelebration, type RunBest } from './dock-celebration.js';

export type { LandMode } from './controller.js';

export interface LandDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  sky: THREE.Object3D;
  sunDisc: THREE.Object3D;
  sunDir: THREE.Vector3;
  /** The boat camera's own state: snapshotted on entry, restored on exit. */
  camState: CamState;
  fpState: FpState;
  lightMats: LightMatEntry[];
  getTodK(): number;
  /** Runs the cascaded-shadow sweep over newly built geometry. */
  onBuilt(root: THREE.Object3D): void;
  isTouch: boolean;
  getBoat(): { x: number; z: number; h: number; speed: number };
  getHullLen(): number;
  getModel(): BoatModel;
  /** Why the boat cannot be left right now (a fish on the line, a catch card up, diving), or null. */
  refuse(): string | null;
  /** True while the driver is over the side. F is the game's one interact verb, so underwater it
   * belongs to the diver (entities/life/wreck-treasure.ts opens treasure with it) and the tie-up
   * hook below has to stand down — otherwise prising open a strongbox also answers "Climb back
   * aboard first". Optional: without it this module behaves exactly as it did before diving had a
   * use for F. */
  diving?(): boolean;
  /** Called on the way ashore: reel in an idle line, so fishing never holds a reference into a boat nobody is driving. */
  prepare(): void;
  toast(msg: string): void;
  /** The wallet + inventory the venue panel buys through (game/economy/system.ts `shop`). */
  shop: ShopPort;
  gameRunning(): boolean;
  /** The casino's slot machines (game/casino): opened instead of the shelf panel when the interaction is in the casino. */
  casino?: { open(id: string, done: () => void): void; close(): void; ambience(dt: number, level: number): void };
  /** The biggest fish landed this run, hung on the dock with a crowd round it when you step ashore
   * (dock-celebration.ts). Omitted or null = nothing to show. */
  getRunBest?(): RunBest | null;
  /** Your own Keys Run Estates lots: walkable, and their docks are somewhere to tie up. */
  estates?(): readonly WalkableEstate[];
}

export interface LandSystem {
  readonly mode: LandMode;
  readonly town: Town;
  /** While ashore the boat is pinned where you left it; call on the state each fixed step. */
  holdBoat(s: BoatState): BoatState;
  /** One fixed physics step. */
  step(dt: number): void;
  /** Once per frame, after the fixed-step loop: the single place mode changes are applied. */
  syncMode(): void;
  /** Land camera for this frame (only call while `mode === 'land'`). */
  updateCamera(dt: number, t: number): void;
  /** Every frame, after the camera is final: town LOD, prompts, body, mooring line. */
  update(dt: number, t: number): void;
  exitToBoat(): void;
  dispose(): void;
}

function $(id: string): HTMLElement | null { return document.getElementById(id); }

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();

interface Snapshot {
  camYaw: number; camPitchOff: number; camZoom: number;
  fpDYaw: number; fpDPitch: number; fpView: number; fpPref: boolean;
  near: number; far: number; fov: number;
}

export function createLandSystem(deps: LandDeps): LandSystem {
  const { scene, camera } = deps;
  const ctl: LandController = createLandController({ canvas: deps.canvas, estates: deps.estates });
  const hud: LandHudHandles = createLandHud(deps.isTouch, deps.shop);
  const town: Town = createTown({ scene, lightMats: deps.lightMats, getTodK: deps.getTodK, onBuilt: deps.onBuilt });

  let prevMode: LandMode = 'boat';
  let snap: Snapshot | null = null;
  let body: Human | null = null;
  let rope: THREE.Mesh | null = null;
  let panel: 'none' | 'open' = 'none';
  const visits = new Map<string, number>();
  let lastDockPrompt: string | null = null;
  // Cosmetics (entities/life/outfit.ts): dresses the walking body and the captain from the shared
  // Inventory.wearing. Lives here because this facade already owns the body and is handed the model
  // and the shadow sweep -- which keeps game/world.ts untouched.
  const outfit = createOutfitSync({ body: () => body, model: () => deps.getModel(), onBuilt: deps.onBuilt });
  const celebration = createDockCelebration({ scene, onBuilt: deps.onBuilt, toast: deps.toast });

  // ---------------------------------------------------------------- the player's body
  function ensureBody(): Human {
    if (body) return body;
    body = makeHuman({ walker: true, skin: 0xd9a27f, shirt: 0xf26b5b, shortSleeve: true, shorts: 0x2b4a6e, cap: 0xffffff, glasses: true, shoes: 0xe9e4d8, hair: 0x3b2a1e });
    body.group.visible = false;
    scene.add(body.group);
    deps.onBuilt(body.group);
    return body;
  }
  function ensureRope(): THREE.Mesh {
    if (rope) return rope;
    rope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 5), new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.9 }));
    rope.visible = false;
    scene.add(rope);
    return rope;
  }

  // ---------------------------------------------------------------- actions (land verbs)
  function closePanel(): void { hud.closePanel(); deps.casino?.close(); }
  function interact(): void {
    if (ctl.mode !== 'land' || !ctl.state) return;
    if (panel === 'open') { closePanel(); return; }
    const hit = town.nearestInteract(ctl.state.x, ctl.state.z);
    if (!hit) { deps.toast('Nothing to do here. Try a door.'); return; }
    const i = hit.interact;
    panel = 'open';
    ctl.buttons.fwd = ctl.buttons.back = ctl.buttons.left = ctl.buttons.right = ctl.buttons.sprint = false;
    if (i.venue === 'casino' && deps.casino) {
      deps.casino.open(i.id, () => { panel = 'none'; });
    } else if (i.kind === 'venue' && i.venue) {
      const n = visits.get(i.venue) ?? 0; visits.set(i.venue, n + 1);
      hud.openVenue(i.venue, n, () => { panel = 'none'; });
    } else {
      hud.openPlaque('Plaque', i.text ?? '', () => { panel = 'none'; });
    }
  }
  function board(): void {
    if (panel === 'open') { closePanel(); return; }
    const d = ctl.boardDistance();
    const bearing = ctl.boatBearing();
    const r = ctl.board();
    if (r === 'far') deps.toast(`Your boat is ${Math.round(d)} m ${bearing} of here. Press B again to take a cab back to the dock.`);
    else if (r === 'cab') deps.toast('A cab takes you back to the dock. Press B to climb aboard.');
  }
  ctl.bind({
    interact, board, close: closePanel,
    view: () => { deps.toast(cycleLandView(ctl.cam)); },
  });

  // ---------------------------------------------------------------- tie up (boat mode)
  function tieUp(): void {
    if (!deps.gameRunning() || ctl.mode !== 'boat') return;
    const why = deps.refuse();
    if (why) { deps.toast(why); return; }
    const boat = deps.getBoat();
    const r = ctl.canTieUp(boat, deps.getHullLen());
    if (!r.ok) { deps.toast(r.reason); return; }
    // Build the town now if the camera has not already caused it to be: stepping onto a dock must
    // never reveal an empty pad. (In normal play it was built on approach, long before this.)
    town.ensureBuilt();
    deps.prepare();
    const e = ctl.tryEnter(boat, deps.getHullLen());
    if (!e.ok) { deps.toast(e.reason); return; }
    const m = ctl.mooring!;
    if (m.estate) { deps.toast(`Tied up at your own dock, ${m.marina}. WASD to walk your land, B to go back to the boat.`); return; }
    deps.toast(m.marina.startsWith('Boot Key Harbor City')
      ? 'Tied up at Boot Key Harbor City Marina. WASD to walk, drag to look, F to use things, B to go back to the boat.'
      : `Tied up at ${m.marina}. Nothing much here but the dock — Boot Key Harbor City Marina has the town. B to go back to the boat.`);
  }
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyF' || e.repeat || ctl.mode !== 'boat') return;
    // Over the side, F is the diver's (see `LandDeps.diving`): stand down rather than answer a
    // dive-mode keypress with a refusal about tying up.
    if (deps.diving?.()) return;
    const start = $('start');
    if (start && !start.classList.contains('hidden')) return;
    tieUp();
  });

  // ---------------------------------------------------------------- mode-change handling
  function setBoatUI(ashore: boolean): void {
    $('gauges')?.classList.toggle('hidden', ashore);
    $('mapbox')?.classList.toggle('hidden', ashore);
    $('scorebox')?.classList.toggle('hidden', ashore);
    $('hint')?.classList.toggle('hidden', ashore); // ui/hud.ts only refreshes it while driving, so it would sit there frozen
    if (deps.isTouch) $('touch')?.classList.toggle('hidden', ashore);
    hud.showHud(ashore);
    hud.showTouch(ashore && deps.isTouch);
  }

  function syncMode(): void {
    if (ctl.mode === prevMode) return;
    const { camState, fpState } = deps;
    if (ctl.mode === 'land') {
      snap = {
        camYaw: camState.yaw, camPitchOff: camState.pitchOff, camZoom: camState.zoom,
        fpDYaw: fpState.dYaw, fpDPitch: fpState.dPitch, fpView: fpState.view, fpPref: fpState.pref,
        near: camera.near, far: camera.far, fov: camera.fov,
      };
      setBoatUI(true);
      ensureBody().group.visible = ctl.cam.mode === 'third';
      ensureRope().visible = true;
      // The run's trophy goes up on the town dock; at your own estate the fish already hangs there.
      if (ctl.mooring && !ctl.mooring.estate) celebration.onAshore(deps.getRunBest?.() ?? null, ctl.mooring);
    } else {
      // Put back exactly what we took. near/far/fov first, with a projection update, so a frame
      // never renders the boat with the walking camera's planes.
      if (snap) {
        camera.near = snap.near; camera.far = snap.far; camera.fov = snap.fov;
        camera.updateProjectionMatrix();
        camState.yaw = snap.camYaw; camState.pitchOff = snap.camPitchOff; camState.zoom = snap.camZoom;
        fpState.dYaw = snap.fpDYaw; fpState.dPitch = snap.fpDPitch; fpState.view = snap.fpView; fpState.pref = snap.fpPref;
        snap = null;
      }
      camState.dragging = false;
      setBoatUI(false);
      panel = 'none';
      if (body) body.group.visible = false;
      if (rope) rope.visible = false;
      celebration.onLeaveShore();
      deps.toast('Back aboard.');
    }
    prevMode = ctl.mode;
  }

  // ---------------------------------------------------------------- place names
  function placeFor(x: number, z: number): { place: string; sub: string } {
    if (ctl.mooring?.estate && groundAt(x, z) === null) return { place: ctl.mooring.marina, sub: 'Your estate' };
    const inside = town.insideLot(x, z);
    if (inside) return { place: VENUES[LOTS.find((l) => l.id === inside)?.venue ?? 'bar'].name, sub: 'Boot Key Harbor City' };
    const g = groundAt(x, z);
    if (g !== null && g < PAD_Y - 0.05) return { place: ctl.mooring?.marina ?? 'Marina', sub: 'Dock' };
    const [u, v] = toLocal(TOWN_FRAME, x, z);
    const names: Record<string, string> = {
      promenade: 'Harbor Promenade', 'harbor-drive': 'Harbor Drive', 'harbor-sidewalk': 'Harbor Drive', 'palm-ave': 'Palm Avenue', 'palm-ave-w': 'Palm Avenue',
      'palm-ave-e': 'Palm Avenue', 'sombrero-blvd': 'Sombrero Boulevard', 'blvd-sidewalk-n': 'Sombrero Boulevard', 'blvd-sidewalk-s': 'Sombrero Boulevard', 'back-lot': 'Back lot', 'back-lane': 'Back lane',
    };
    for (let i = SURFACES.length - 1; i >= 0; i--) {
      const s = SURFACES[i];
      if (u >= s.u0 && u <= s.u1 && v >= s.v0 && v <= s.v1) return { place: names[s.id] ?? 'Boot Key Harbor City', sub: 'Boot Key Harbor City' };
    }
    return { place: 'Boot Key Harbor City', sub: 'Marathon, Florida Keys' };
  }

  // ---------------------------------------------------------------- the casino's room tone
  const [casinoDoorX, casinoDoorZ] = toWorld(TOWN_FRAME, CASINO_LOT.door, CASINO_LOT.v0);
  /** 1 on the floor, 0 outside; a muffled 0.3 fading out over the 12 m in front of the door, so you hear it before you see inside. */
  function casinoLevel(): number {
    if (ctl.mode !== 'land') return 0;
    if (town.insideLot(camera.position.x, camera.position.z) === 'casino') return 1;
    const d = Math.hypot(camera.position.x - casinoDoorX, camera.position.z - casinoDoorZ);
    return d < 12 ? 0.3 * (1 - d / 12) : 0;
  }

  // ---------------------------------------------------------------- per-frame
  function updateBodyAndRope(): void {
    const w = ctl.state, m = ctl.mooring;
    if (!w || !m) return;
    const b = ensureBody();
    b.group.visible = ctl.cam.mode === 'third';
    const amount = Math.min(1, w.speed / 2.4);
    const bob = animateGait(b, w.gait, amount);
    b.group.position.set(w.x, w.y + bob, w.z);
    b.group.rotation.y = w.yaw + Math.PI;
    b.update(performance.now() / 1000, 0);
    // mooring line: from the hull's bow cleat to the plank you stepped off from
    const r = ensureRope();
    const model = deps.getModel();
    _a.set(0, 0.75, -m.hullLen * 0.3); model.group.localToWorld(_a);
    _b.set(m.dockX, DECK_TOP + 0.25, m.dockZ);
    _d.subVectors(_b, _a);
    const len = _d.length();
    r.visible = len < 40;
    r.position.copy(_a).addScaledVector(_d, 0.5);
    r.quaternion.setFromUnitVectors(UP, _d.divideScalar(len || 1));
    r.scale.set(1, len, 1);
  }

  function updateHud(): void {
    const w = ctl.state;
    if (!w) return;
    const p = placeFor(w.x, w.z);
    hud.setPlace(p.place, p.sub);
    const d = ctl.boardDistance();
    hud.setBoat(d <= 9 ? 'Boat: <b>alongside</b> · B to board' : `Boat: <b>${Math.round(d)} m</b> ${ctl.boatBearing()}`);
    if (panel === 'open') { hud.setPrompt(null); return; }
    const hit = town.nearestInteract(w.x, w.z);
    hud.setPrompt(hit ? hit.interact.prompt : null);
  }

  function updateDockPrompt(): void {
    let want: string | null = null;
    if (ctl.mode === 'boat' && deps.gameRunning()) {
      const boat = deps.getBoat();
      const r = ctl.canTieUp(boat, deps.getHullLen());
      // Only the actionable prompt. "Slow down to tie up" used to sit in the middle of the
      // screen the whole time you had way on anywhere near a dock, which is most of the time you
      // are near one — and it told you nothing you could act on. Slow down and the F prompt
      // appears by itself; press F while still moving and catch-flow.ts still toasts the reason.
      if (r.ok && !deps.refuse()) want = 'F  Tie up and go ashore';
    }
    if (want !== lastDockPrompt) { hud.setDockPrompt(want); lastDockPrompt = want; }
  }

  // ---------------------------------------------------------------- debug (verification only)
  (window as unknown as { __landDebug?: unknown }).__landDebug = {
    mode: () => ctl.mode,
    state: () => ({ mode: ctl.mode, player: ctl.state && { x: +ctl.state.x.toFixed(2), y: +ctl.state.y.toFixed(2), z: +ctl.state.z.toFixed(2), yaw: +ctl.state.yaw.toFixed(2) }, mooring: ctl.mooring, boardDistance: +ctl.boardDistance().toFixed(1), cam: { ...ctl.cam }, panel }),
    town: () => town.stats(),
    tieUp,
    interact,
    board,
    exit: () => { ctl.exitToBoat(); },
    view: (m: 'first' | 'third') => { ctl.cam.mode = m; },
    look: (yaw: number, pitch: number) => { ctl.cam.yaw = yaw; ctl.cam.pitch = pitch; },
    place: (x: number, z: number, yaw?: number) => ctl.debugPlace(x, z, yaw),
    interactWorld: (id: string) => town.interactWorld(id),
    nearest: () => ctl.state && town.nearestInteract(ctl.state.x, ctl.state.z),
    ensureBuilt: () => town.ensureBuilt(),
    hideTown: (hidden: boolean) => town.debugHide(hidden),
    hideInterior: (id: string, hidden: boolean) => town.debugHideInterior(id, hidden),
    camera: () => ({ near: camera.near, far: camera.far, fov: +camera.fov.toFixed(2), x: +camera.position.x.toFixed(1), y: +camera.position.y.toFixed(1), z: +camera.position.z.toFixed(1) }),
    boatCam: () => ({ yaw: +deps.camState.yaw.toFixed(3), pitchOff: +deps.camState.pitchOff.toFixed(3), zoom: deps.camState.zoom, dYaw: +deps.fpState.dYaw.toFixed(3), dPitch: +deps.fpState.dPitch.toFixed(3), view: deps.fpState.view, pref: deps.fpState.pref }),
    shops: () => LOTS.map((l) => ({ id: l.id, venue: l.venue, door: l.door, v0: l.v0, depth: l.v1 - l.v0 })),
    pad: PAD,
    // verification only: own everything / wear / strip (the till is not wired to the wallet yet)
    wardrobe: {
      giveAll: () => { let inv = emptyInventory(); for (const s of VENUES.gifts.sells) inv = buy(inv, 'gifts', s.id, 1e9, 0).inventory; wardrobe.set(inv); },
      buy: (id: string) => { const r = buy(wardrobe.get(), 'gifts', id, 1e9, 0); wardrobe.set(r.inventory); return r.reason ?? 'ok'; },
      wear: (k: string) => { wardrobe.wear(k); },
      takeOff: (s: string) => { wardrobe.takeOff(s); },
      state: () => wardrobe.get(),
    },
    colliders: COLLIDERS.length,
    trophy: () => celebration.where,
  };

  return {
    get mode() { return ctl.mode; },
    town,

    holdBoat(s) {
      const m = ctl.mooring;
      if (ctl.mode !== 'land' || !m) return s;
      // Only the planar pose and speed — never y/pitch/roll, or the hull would stop riding the swell
      // (same rule as the net agent's applyNetCorrection: "corrections only ever write x, z, heading, speed").
      return { ...s, x: m.boatX, z: m.boatZ, h: m.boatH, speed: 0, dvx: 0, dvz: 0 };
    },

    step(dt) { ctl.step(dt, panel === 'open'); },

    syncMode,

    updateCamera(dt) {
      const w = ctl.state;
      if (!w) return;
      updateLandCamera(camera, ctl.cam, w, dt, COLLIDERS, town.insideLot(w.x, w.z) !== null);
      // updateCamera (boat) does these itself at its tail; ours has no idea the sky dome exists
      camera.updateMatrixWorld(true);
      deps.sky.position.copy(camera.position);
      deps.sunDisc.position.copy(camera.position).addScaledVector(deps.sunDir, 5000);
      deps.sunDisc.lookAt(camera.position);
    },

    update(dt, t) {
      town.update(dt, t, camera.position);
      outfit.update(); // two pointer compares per frame; builds nothing unless the outfit changed
      if (deps.casino) deps.casino.ambience(dt, casinoLevel());
      updateDockPrompt();
      if (ctl.mode === 'land') { updateBodyAndRope(); updateHud(); celebration.update(dt, t); }
    },

    exitToBoat() { ctl.exitToBoat(); },

    dispose() { ctl.dispose(); town.dispose(); celebration.clear(); },
  };
}
