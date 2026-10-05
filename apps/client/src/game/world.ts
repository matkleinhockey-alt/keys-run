/**
 * `initWorld()`: the explicit, ordered boot sequence — see docs/ARCHITECTURE.md requirement 4
 * ("module top level stays declaration-only; export an explicit initWorld() calling build steps
 * in today's order. Do not rely on import side effects.").
 *
 * This mirrors legacy/index.html's top-to-bottom script evaluation order: renderer/scene/sky →
 * water → seafloor → islands → bridge → landmarks → coral → clouds → particles → marinas →
 * boat/electronics → camera/input → HUD/minimap → start screen → placement. Every module it
 * calls is declaration-only at its own top level (no import-time side effects) — all building
 * happens inside the `create*`/`make*` calls below, in this order.
 */
import * as THREE from 'three';
import { chainZ } from '@keysrun/shared/world/chain';
import { WB } from '@keysrun/shared/world/depth';
import { BOATS, SPEED_SCALE, type Boat } from '@keysrun/shared/content/boats';
import { SEA_STATES } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { createBoatState, stepBoat, type BoatState, type BoatEnv, type DockRect, type Piling, type SimEvent, type FightTarget } from '@keysrun/shared/sim/boat';

import { createScene, isTouch } from '../core/scene.js';
import { createTimeOfDay } from '../core/time-of-day.js';
import { probeGpu, detectDefaultTier, loadSavedTier, saveTier, getQualitySettings, QUALITY_TIERS, type QualityTier, type QualitySettings } from '../core/quality.js';
import { createCascadedShadows } from '../core/shadows.js';
import { createPostFX } from '../core/postfx.js';
import { createProfiler } from '../ui/profiler.js';
import { createWater } from '../world/water.js';
import { installUnderwaterFog } from '../world/underwater/fog-override.js';
import { createUnderwaterWorld } from '../world/underwater/index.js';
import { createSeafloor } from '../world/seafloor.js';
import { createIslands } from '../world/islands.js';
import { createBridge } from '../world/bridge.js';
import { createLandmarks } from '../world/landmarks.js';
import { createReef } from '../world/reef/index.js';
import { createFishWorld } from '../entities/fish/index.js';
import type { Threat } from '../entities/fish/types.js';
import { createClouds } from '../world/clouds.js';
import { createMarinas } from '../world/marinas.js';
import { createParticleSystem } from '../world/particles.js';

import { makeBoat, type BoatModel } from '../entities/boat/model.js';
import { createCrewSystem } from '../entities/crew-model/index.js';
import { createElectronics, type BoatReadout } from '../entities/boat/electronics.js';
import { applyBoatVisuals, sampleWaterHeight } from '../entities/boat/visuals.js';
import { createBoatInput, bindBoatInput, type BoatStateBox } from '../entities/boat/input.js';
import { createCamState, createFpState, updateCamera, cycleView, bindCameraPointerControls } from '../entities/camera.js';

import type { DiverEvent } from '@keysrun/shared/sim/diver';
import { createDiverController, NEUTRAL_BOAT_INPUT } from '../entities/diver/controller.js';
import { createDiverModel } from '../entities/diver/model.js';
import { applyDiverVisuals } from '../entities/diver/visuals.js';
import { updateDiverCamera } from '../entities/diver/camera.js';
import { updateDiverHud, showDiverHud, clearBlackoutOverlay } from '../entities/diver/hud.js';

import { createFishing } from './fishing/index.js';
import { F as FishF, lineOut as fishingLineOut } from './fishing/state.js';
import { createCatchFlow } from './catch/catch-flow.js';
import { bindCatchInput } from './catch/input.js';

import { updateHUD } from '../ui/hud.js';
import { createMinimap } from '../ui/minimap.js';
import { populateBoatCards, showHud, showStart } from '../ui/start.js';
import { toast } from '../ui/toast.js';
import { spotClear, findClearSpot } from '../state/game.js';
import { SPAWN_X, SPAWN_DZ, SPAWN_H } from '../state/constants.js';

const DT = 1 / 30;

const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Shortest-path angle interpolation, so a heading crossing the ±π seam doesn't spin the long way. */
const lerpAngle = (a: number, b: number, t: number): number => {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
};

export interface World {
  resize(): void;
  frame(dt: number): void;
  renderer: THREE.WebGLRenderer;
}

function hullOf(spec: Boat) {
  return { len: spec.len, beam: spec.beam, top: spec.top, accel: spec.accel, turn: spec.turn, draft: spec.draft, cat: spec.cat };
}

export function initWorld(wrap: HTMLElement): World {
  // 0. Underwater global fog override (docs/ARCHITECTURE.md "The underwater world" →
  // "Rendering") — must run before anything compiles a shader that includes `<fog_fragment>`, so
  // first thing, before any create*() below.
  installUnderwaterFog();

  // 1. renderer / scene / sky / lighting
  const sceneCtx = createScene(wrap);
  const { renderer, scene, camera, sunDir } = sceneCtx;

  // Topside near/far (core/scene.ts's defaults, 0.5/9000 — sized for the ~1,900 m horizon).
  // entities/diver/camera.ts drives its own, much tighter near/far while submerged (its header
  // explains why: that's the actual fix for caustics.ts's documented depth-precision bug); these
  // are read once, here, before anything can have touched them, so frame()'s mode-change handling
  // below can restore the exact original values the instant the diver climbs back aboard.
  const TOPSIDE_CAMERA_NEAR = camera.near;
  const TOPSIDE_CAMERA_FAR = camera.far;

  // 1b. quality tier: a saved choice wins, otherwise auto-detect from a quick GPU probe
  // (docs/ARCHITECTURE.md Part 2 "Quality tiers" — Low must run on an integrated GPU).
  const gpuProbe = probeGpu(renderer.getContext());
  let quality = getQualitySettings(loadSavedTier() ?? detectDefaultTier(gpuProbe));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  (scene.fog as THREE.Fog).far = quality.fogFar;

  // 2. water (+ the shared depth-grid cache it reads)
  const water = createWater(sunDir, quality.waterSegments);
  scene.add(water.water);

  // 3. time of day (depends on scene + water's sky-colour uniform)
  const tod = createTimeOfDay(sceneCtx, water.uniforms.uSky);

  // 4. sea floor
  const seafloor = createSeafloor();
  scene.add(seafloor.group);

  // 5. islands + vegetation + runway
  const islands = createIslands();
  scene.add(islands.group);

  // 6. US-1 / Seven Mile Bridge
  const bridge = createBridge();
  scene.add(bridge.group);

  // 7. landmarks (Sombrero light, Faro Blanco, reef moorings)
  scene.add(createLandmarks());

  // 8. reef — chunked, deterministic, LOD'd (see world/reef/index.ts; this replaces the old
  // flat 620-icosahedra coral scatter per docs/ARCHITECTURE.md's "Reef"). Resident chunks follow
  // the camera (reef.update call in frame() below), not the boat, since that's what's actually
  // rendered — see world/reef/chunk-manager.ts's header.
  const reef = createReef();
  scene.add(reef.group);

  // 8b. fish — schools of VIS creatures, deterministic resident reef schools plus a roaming
  // layer (entities/fish/index.ts); see docs/ARCHITECTURE.md "Fish at realism *and* density" and
  // "Fish ownership — three tiers". `fishWorld.update` is called from frame() below with a
  // *focus* point that follows whichever viewer is actually in the water (the diver once
  // entities/diver/** takes over, the boat otherwise) plus the boat's own position as a standing
  // threat and the diver as an optional extra threat.
  const fishWorld = createFishWorld();
  scene.add(fishWorld.group);

  // 9. clouds (one InstancedMesh — see world/clouds.ts header; count fixed at boot per the
  // initial quality tier since, being a single draw call either way, it isn't worth a rebuild
  // on every quality change the way water tessellation or shadows are).
  const clouds = createClouds(quality.cloudInstances);
  scene.add(clouds.group);
  tod.setCloudMat(clouds.material);

  // 10. marinas / docks / mooring field / golf
  const marinas = createMarinas();
  scene.add(marinas.group);

  // 11. particles (wake + spray)
  const particles = createParticleSystem(renderer.getPixelRatio());
  scene.add(particles.points);

  // 12. boat + electronics
  const pilings: Piling[] = bridge.pilings;
  const dockRects: DockRect[] = marinas.dockRects;

  const readout: BoatReadout = { x: 0, z: 0, h: 0, speed: 0 };
  const electronics = createElectronics(readout);

  let boatSpec: Boat = BOATS[1]; // legacy's default `let boatSpec = BOATS[1]` (the Grady-White)
  let model: BoatModel = makeBoat(boatSpec, { lightMats: tod.lightMats, todK: tod.getK(), mfdTex: electronics.mfdTex, gpsTex: electronics.gpsTex, sonTex: electronics.sonTex });
  scene.add(model.group);

  const spawnZ = chainZ(SPAWN_X) + SPAWN_DZ;
  const spot = findClearSpot(SPAWN_X, spawnZ, { draft: boatSpec.draft, len: boatSpec.len, dockRects, pilings }, { x: SPAWN_X, z: spawnZ });
  let curState: BoatState = createBoatState(spot.x, spot.z, SPAWN_H);
  model.group.position.set(curState.x, curState.y, curState.z);

  // 12b. cascaded shadows + post-processing (docs/ARCHITECTURE.md Part 2 items 2 and 5). Built
  // after every other scene.add() above so applyToSubtree's one traversal catches everything —
  // see core/shadows.ts's header for why the water material needs the separate registration call.
  const shadowKey = (s: QualitySettings['shadows']): string => `${s.enabled}:${s.cascades}:${s.mapSize}:${s.maxFar}`;
  let shadows = createCascadedShadows(camera, scene, sunDir, quality.shadows);
  let curShadowKey = shadowKey(quality.shadows);
  shadows.registerCustomMaterial(water.material, water.baseOnBeforeCompile);
  shadows.registerCustomMaterial(islands.frondMaterial, islands.frondBaseCompile);
  shadows.applyToSubtree(scene);
  let postfx = createPostFX(renderer, scene, camera, quality.post);

  // 12b-2. deck crew (docs/ARCHITECTURE.md's first external 3D asset — see
  // entities/crew-model/index.ts and docs/ASSET-LICENCES.md). Loads async in the background and
  // never blocks this function returning; figures pop onto the boat whenever the glTF resolves.
  // Parented to model.group (via attachTo), not scene, so crew ride the hull's heave/pitch/roll
  // like everything else aboard. Deliberately built *after* 12b just above (not back at 12 with
  // the rest of boat/electronics setup) so the onGroupReady hook below can close over a `shadows`
  // that already exists — every (re)build, sync or from the async glTF arriving later, re-runs
  // applyToSubtree on just the new crew group so their materials get the CSM cascade setup too.
  const crewSystem = createCrewSystem(quality.tier, (group) => shadows.applyToSubtree(group));
  crewSystem.attachTo(model, boatSpec);

  // 12c. underwater world (docs/ARCHITECTURE.md "The underwater world" → "Rendering") — marine
  // snow, the surface-crossing transition, and the caustics/lens-wetting/(High+) god-rays post
  // effects appended onto postfx's composer. Built after postfx so attachPostFX has a composer to
  // attach to; re-attached below every time applyQuality() rebuilds that composer.
  const underwater = createUnderwaterWorld({ scene, camera, renderer, sunDisc: sceneCtx.sunDisc, sky: sceneCtx.sky });
  underwater.attachPostFX(postfx.composer, quality.tier);

  const profiler = createProfiler();
  // The postprocessing composer issues several internal renderer.render() calls per frame
  // (RenderPass, an optional NormalPass for SSAO, the final EffectPass blit); with autoReset left
  // on, renderer.info resets on each of those and profiler.sample would only ever see the last
  // (tiny, full-screen-quad) one. Reset it ourselves once per frame instead, right before
  // postfx.render(), so the counts profiler.sample reads after are the frame's real total.
  renderer.info.autoReset = false;

  function setQualityLabels(tier: QualityTier, announce: boolean): void {
    const Tier = tier[0].toUpperCase() + tier.slice(1);
    const b1 = document.getElementById('btnQuality'); if (b1) b1.textContent = '⚙ ' + Tier;
    const b2 = document.getElementById('btnQualityStart'); if (b2) b2.textContent = 'Quality: ' + Tier;
    if (announce) toast('Quality: ' + Tier);
  }
  function applyQuality(tier: QualityTier, announce = true): void {
    quality = getQualitySettings(tier);
    saveTier(tier);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    (scene.fog as THREE.Fog).far = quality.fogFar;
    water.setTessellation(quality.waterSegments);
    // Only tear down and recreate the CSM lights if their shape actually changed. Disposing and
    // recreating DirectionalLights bumps three's internal light-state version even when the
    // resulting light *count* is unchanged (e.g. Medium -> High are both 1 cascade), which can
    // desync a material's cached WebGLProgram from its uniforms for one frame — rebuilding only
    // when something shadow-relevant truly changed avoids that churn entirely in the common case.
    const nextShadowKey = shadowKey(quality.shadows);
    if (nextShadowKey !== curShadowKey) {
      curShadowKey = nextShadowKey;
      shadows.dispose();
      shadows = createCascadedShadows(camera, scene, sunDir, quality.shadows);
      shadows.registerCustomMaterial(water.material, water.baseOnBeforeCompile);
      shadows.registerCustomMaterial(islands.frondMaterial, islands.frondBaseCompile);
      shadows.applyToSubtree(scene);
      // Disposing+recreating the CSM's DirectionalLights bumps three's internal light-state
      // version even for materials whose own cache key doesn't change, which can (rarely) leave a
      // material's cached WebGLProgram attached with a stale uniforms object for one frame — see
      // this project's report. Forcing every material to forget its cached program (so the next
      // getProgram() call treats it as brand new and re-runs onBeforeCompile unconditionally)
      // closes that window entirely. `renderer.properties` is undocumented-but-public three
      // internals (WebGLProperties), hence the cast.
      const rendererProps = (renderer as unknown as { properties: { remove(o: THREE.Material): void } }).properties;
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.InstancedMesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) rendererProps.remove(m);
      });
    }
    postfx.dispose();
    postfx = createPostFX(renderer, scene, camera, quality.post);
    underwater.attachPostFX(postfx.composer, quality.tier);
    crewSystem.setQuality(quality.tier);
    resize();
    setQualityLabels(tier, announce);
  }
  setQualityLabels(quality.tier, false);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') profiler.toggle();
    if (e.code === 'KeyG') applyQuality(QUALITY_TIERS[(QUALITY_TIERS.indexOf(quality.tier) + 1) % QUALITY_TIERS.length]);
  });
  document.getElementById('btnQuality')?.addEventListener('click', () => {
    applyQuality(QUALITY_TIERS[(QUALITY_TIERS.indexOf(quality.tier) + 1) % QUALITY_TIERS.length]);
  });
  document.getElementById('btnQualityStart')?.addEventListener('click', () => {
    applyQuality(QUALITY_TIERS[(QUALITY_TIERS.indexOf(quality.tier) + 1) % QUALITY_TIERS.length]);
  });

  // 13. camera + input
  const camState = createCamState();
  const fpState = createFpState();
  bindCameraPointerControls(renderer.domElement, camState, fpState);

  const input = createBoatInput();
  const stateBox: BoatStateBox = { state: curState };

  // Boat input (entities/boat/input.ts) owns the raw KeyT listener and doesn't know about
  // Shift — fishing's drag (legacy "T tightens · Shift+T loosens", see fishing/input.ts's
  // header) needs that distinction, so toggleTrim below tracks it itself rather than reaching
  // into a module outside this task's scope.
  let shiftHeld = false;
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftHeld = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; });

  let seaIdx = 1; // legacy's initial `seaIdx=1` ("Choppy")
  let sw = 0.9, ch = 1; // legacy's initial SW/CH (index.html:435)
  let game = { running: false };

  // 13b. diver (entities/diver/**): jump off the boat, free-dive, swim, climb back aboard. See
  // controller.ts's header for the authority-handoff plan — the boat keeps stepping on a neutral
  // input while its driver is over the side (see fixedStep below); the net agent wires real
  // server-authoritative drift later behind that same seam. Created before fishing (next) so
  // fishing's `isSuspended` guard can close over `diver` — see that call's own comment.
  const diver = createDiverController({ canvas: renderer.domElement });
  const diverModel = createDiverModel();
  diverModel.group.visible = false;
  scene.add(diverModel.group);

  // 13c. rod fishing + catch flow (docs/ARCHITECTURE.md "Rod fishing, server-authoritative").
  // `fishing` owns cast/wait/bite/fight and the first-person rod view; `catchFlow` is the one
  // shared landing path both it and entities/speargun (once the diver lands) feed into for the
  // catch card / cooler / weigh-in.
  const catchFlow = createCatchFlow({
    scene,
    getModel: () => model,
    getBoatSpec: () => ({ id: boatSpec.id, brand: boatSpec.brand, name: boatSpec.name }),
  });
  const fishing = createFishing({
    scene,
    camera,
    getModel: () => model,
    fp: fpState,
    camState,
    particles,
    boatInput: input,
    getBoat: () => stateBox.state,
    onLanded(fish) { catchFlow.landFish({ key: fish.key, weight: fish.weight, x: fish.fx, z: fish.fz, zone: fish.zone }); },
    onActionWhileCaught() { catchFlow.releaseFish(); },
    // Space doubles as the diver's ascend key (entities/diver/input.ts) and this module's own
    // window-level Space listener has no idea diving exists — see fishing/input.ts's
    // `isSuspended` doc comment for the bug this closes (a stray rod cast firing mid-dive).
    isSuspended: () => diver.mode === 'diver',
  });
  bindCatchInput(catchFlow, () => stateBox.state);

  function setDiveUI(diving: boolean): void {
    document.getElementById('gauges')?.classList.toggle('hidden', diving);
    document.getElementById('mapbox')?.classList.toggle('hidden', diving);
    document.getElementById('scorebox')?.classList.toggle('hidden', diving);
    if (isTouch()) {
      document.getElementById('touch')?.classList.toggle('hidden', diving);
      document.getElementById('touchDiver')?.classList.toggle('hidden', !diving);
    }
    showDiverHud(diving);
    diverModel.group.visible = diving;
    if (!diving) clearBlackoutOverlay();
  }

  function toggleDive(): void {
    if (!game.running) return;
    if (diver.mode === 'boat') {
      // legacy-mirroring guard (see the onGo/placeBoat reelIn call above): going overboard with a
      // line out would otherwise leave fishing's state machine holding a rod-tip/bobber reference
      // while nothing drives its update loop (fixedStep still runs, but the player's attention —
      // and this frame's camera — is about to move to the diver rig).
      if (FishF.state !== 'idle' && FishF.state !== 'caught') fishing.reelIn();
      diver.enterWater(stateBox.state.x, stateBox.state.z, stateBox.state.h);
      setDiveUI(true);
      toast('Overboard — WASD/mouse to swim and look, Space/Ctrl to ascend/descend, Shift to sprint. J to climb back aboard.');
    } else {
      if (!diver.canReboard) { toast('Too far from the boat to climb aboard.'); return; }
      diver.requestReboard();
      setDiveUI(false);
    }
  }
  document.getElementById('btnDive')?.addEventListener('click', toggleDive);
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyJ') toggleDive(); });

  // #btnSun was rendered and styled but never given a click handler — only the `O` key reached
  // toggleSunset(), so the button looked interactive and did nothing (and is the only way to
  // reach sunset on touch, where there is no keyboard at all).
  document.getElementById('btnSun')?.addEventListener('click', () => tod.toggleSunset());

  bindBoatInput(input, stateBox, {
    toggleTrim() {
      if (FishF.state === 'fight') { fishing.setDrag(FishF.drag + (shiftHeld ? -1 : 1)); return; }
      stateBox.state = { ...stateBox.state, trimMode: !stateBox.state.trimMode };
      input.fwd = false; input.back = false;
      toast(stateBox.state.trimMode ? 'Trim mode on — ▲ trims up, ▼ trims down. W/S still change throttle. T to exit.' : 'Trim mode off.');
    },
    shiftGear() {
      const next = ({ D: 'N', N: 'R', R: 'D' } as const)[stateBox.state.gear];
      stateBox.state = { ...stateBox.state, gear: next };
      toast('Gear: ' + next);
    },
    toggleEngine() {
      const on = !stateBox.state.engineOn;
      stateBox.state = { ...stateBox.state, engineOn: on };
      toast(on ? 'Firing them up…' : 'Motors off.');
    },
    toggleSunset() { tod.toggleSunset(); },
    toggleLights() {
      if (model.lights) { model.lights.visible = !model.lights.visible; toast('Underwater lights ' + (model.lights.visible ? 'on' : 'off') + '.'); }
      else toast('This boat has no underwater lights.');
    },
    cycleView() {
      const label = cycleView(fpState, model);
      toast(label + ' — press 1 to switch');
      const b = document.getElementById('btnCam');
      if (b) b.textContent = ['🎥 3rd', '🎥 Helm', '🎥 Tower'][fpState.view];
    },
    setSea(delta) {
      seaIdx = (seaIdx + delta + SEA_STATES.length) % SEA_STATES.length;
      const b = document.getElementById('btnSea');
      if (b) b.textContent = 'Sea: ' + SEA_STATES[seaIdx].n.toLowerCase();
      toast(SEA_STATES[seaIdx].n + ' — ' + SEA_STATES[seaIdx].d);
    },
    zoomChart(k) { electronics.zoom(k); },
    toggleBigChart() { document.getElementById('mapbox')?.classList.toggle('big'); },
    resetCamZoom() { camState.zoom = camState.zoom > 1.4 ? 1 : 1.9; },
  });

  // 14. HUD + minimap
  const minimap = createMinimap();

  // 15. start screen
  function placeBoat(spec: Boat): void {
    boatSpec = spec;
    scene.remove(model.group);
    model = makeBoat(spec, { lightMats: tod.lightMats, todK: tod.getK(), mfdTex: electronics.mfdTex, gpsTex: electronics.gpsTex, sonTex: electronics.sonTex });
    scene.add(model.group);
    crewSystem.attachTo(model, spec); // re-applies CSM setup to the new crew group itself (see its onGroupReady hook above)
    shadows.applyToSubtree(model.group);
    const label = document.getElementById('gBoat');
    if (label) label.textContent = (spec.nickname ? '"' + spec.nickname + '" · ' : '') + spec.brand + ' ' + spec.name + ' · ' + spec.power;
  }
  function unstick(): void {
    const S = boatSpec;
    const okSpot = spotClear(stateBox.state.x, stateBox.state.z, { draft: S.draft, len: S.len, dockRects, pilings })
      ? { x: stateBox.state.x, z: stateBox.state.z }
      : findClearSpot(stateBox.state.x, stateBox.state.z, { draft: S.draft, len: S.len, dockRects, pilings }, { x: SPAWN_X, z: chainZ(SPAWN_X) + SPAWN_DZ });
    stateBox.state = createBoatState(okSpot.x, okSpot.z, stateBox.state.h);
    model.group.position.set(stateBox.state.x, stateBox.state.y, stateBox.state.z);
  }

  populateBoatCards(BOATS, boatSpec, {
    onSelectBoat(spec) { if (!game.running) placeBoat(spec); else boatSpec = spec; },
    onGo() {
      // legacy `if(F.state!=='idle'&&F.state!=='caught') reelIn();` — switching boats mid-cast
      // would otherwise leave the fishing state machine holding a rod-tip/station reference into
      // the boat model placeBoat() is about to replace.
      if (FishF.state !== 'idle' && FishF.state !== 'caught') fishing.reelIn();
      placeBoat(boatSpec);
      unstick();
      showHud();
      if (isTouch()) document.getElementById('touch')?.classList.remove('hidden');
      game.running = true;
      camState.yaw = 0;
      renderer.domElement.focus();
      toast('Head out and get a feel for the ' + boatSpec.name + '.');
    },
  });
  document.getElementById('btnMarina')?.addEventListener('click', () => {
    game.running = false;
    input.fwd = input.back = input.left = input.right = false;
    if (diver.mode === 'diver') { diver.exitToBoat(); setDiveUI(false); }
    const lede = document.getElementById('lede');
    if (lede) lede.textContent = 'Switch boats any time.';
    const go = document.getElementById('btnGo');
    if (go) go.textContent = 'Back on the water';
    showStart();
    document.getElementById('touch')?.classList.add('hidden');
  });

  // 16. placement (already done above, before camera/input bind, mirroring legacy's
  // `placeBoat(boatSpec); unstick();` which ran right after the boat was first built)

  let simTime = 0;
  let acc = 0;
  let prevState: BoatState = curState;
  // Tracks diver.mode so the *involuntary* post-blackout "wake on the boat" recovery (flipped
  // internally by diver.step, not through toggleDive/btnMarina) still flips the DOM/model/camera
  // planes back — see the mode-change check at the top of frame() below.
  let prevDiverMode: 'boat' | 'diver' = 'boat';
  // entities/camera.ts's bindCameraPointerControls (bound once above, mode-agnostic — see its own
  // header) keeps reading pointer drags on the canvas while diving, since it has no idea diving
  // exists. That's harmless to the render (updateCamera is never called while diver.mode==='diver',
  // see frame() below) but it silently mutates camState.yaw/pitchOff and fpState.dYaw/dPitch in the
  // background the whole time the player is looking around underwater (look-to-steer drags the
  // same canvas). Left alone, the topside camera would snap to wherever those drifted the instant
  // control returns to the boat. Snapshot on dive-entry, restore on exit — covers both the manual
  // reboard (toggleDive) and the involuntary post-blackout wake-up, since both only ever surface
  // here, at the single mode-change check.
  let savedBoatCam: { yaw: number; pitchOff: number; dYaw: number; dPitch: number } | null = null;

  function fixedStep(dt: number): SimEvent[] {
    const st = SEA_STATES[seaIdx], k = Math.min(1, dt * 0.5);
    sw += (st.sw - sw) * k; ch += (st.ch - ch) * k;

    simTime += dt;
    // legacy `game.running && F.state!=='caught'` / `F.state==='fight'` / `lineOut()` — read
    // from *this* fixed step's starting fishing state, same one-frame-stale ordering as
    // legacy's `updateBoat(dt,t); updateFishing(dt,t);` (fishing.update runs below, after
    // stepBoat, using the boat position this step just produced).
    const fightActive = FishF.state === 'fight';
    const fightTarget: FightTarget | null = fightActive && FishF.fight ? { x: FishF.fx, z: FishF.fz, running: FishF.fight.running } : null;
    const env: BoatEnv = {
      t: simTime, hull: hullOf(boatSpec), sw, ch, worldBounds: WB, pilings, dockRects,
      canDrive: game.running && FishF.state !== 'caught', fightActive, fightTarget, lineOut: fishingLineOut(), luigiOn: false,
    };
    // While diving, the boat's "driver" is over the side: it keeps stepping (so it keeps existing,
    // and keeps drifting under its own wave/current forces — stepBoat already applies those at
    // zero throttle/steer) but never sees player input. See entities/diver/controller.ts.
    const boatInput = diver.mode === 'diver' ? NEUTRAL_BOAT_INPUT : input;
    const next = stepBoat(stateBox.state, boatInput, env, dt);
    stateBox.state = next;
    fishing.update(dt, simTime, next, sw, ch);
    return next.events;
  }

  function frame(dt: number): void {
    const clamped = Math.min(0.05, dt);
    acc += clamped;
    let steps = 0;
    const events: SimEvent[] = [];
    const diverEvents: DiverEvent[] = [];
    while (acc >= DT && steps < 5) {
      prevState = stateBox.state;
      events.push(...fixedStep(DT));
      diverEvents.push(...diver.step(simTime, DT, stateBox.state.x, stateBox.state.z));
      acc -= DT;
      steps++;
    }
    curState = stateBox.state;

    if (diver.mode !== prevDiverMode) {
      if (diver.mode === 'diver') {
        savedBoatCam = { yaw: camState.yaw, pitchOff: camState.pitchOff, dYaw: fpState.dYaw, dPitch: fpState.dPitch };
      } else {
        // Restore the topside near/far entities/diver/camera.ts's header explains why diving
        // narrows these — leaving its tight far plane applied topside would silently clip the
        // 1,900 m far skirt (world/terrain/lod.ts) and reintroduce the same depth-precision
        // problem this project's caustics fix exists to avoid, just in the other direction.
        camera.near = TOPSIDE_CAMERA_NEAR;
        camera.far = TOPSIDE_CAMERA_FAR;
        camera.updateProjectionMatrix();
        if (savedBoatCam) {
          camState.yaw = savedBoatCam.yaw; camState.pitchOff = savedBoatCam.pitchOff;
          fpState.dYaw = savedBoatCam.dYaw; fpState.dPitch = savedBoatCam.dPitch;
          savedBoatCam = null;
        }
      }
      setDiveUI(diver.mode === 'diver');
      prevDiverMode = diver.mode;
    }

    // Render interpolates the leftover fraction of a step (docs/ARCHITECTURE.md requirement 2):
    // only the smoothly-varying transform fields are blended between the last two completed
    // physics states; discrete/authoritative fields (gear, wakeRing, trim mode, …) always come
    // from the latest one. This is the standard fixed-timestep interpolation trade-off — render
    // lags the simulation by at most one DT (≤33 ms), never extrapolates.
    const alpha = Math.max(0, Math.min(1, acc / DT));
    const renderState: BoatState = alpha === 0 ? curState : {
      ...curState,
      x: lerpN(prevState.x, curState.x, alpha),
      z: lerpN(prevState.z, curState.z, alpha),
      y: lerpN(prevState.y, curState.y, alpha),
      pitch: lerpN(prevState.pitch, curState.pitch, alpha),
      roll: lerpN(prevState.roll, curState.roll, alpha),
      h: lerpAngle(prevState.h, curState.h, alpha),
    };

    readout.x = curState.x; readout.z = curState.z; readout.h = curState.h; readout.speed = curState.speed;

    water.recenter(renderState.x, renderState.z);
    water.update(simTime, Math.max(sw * 1.1, ch), sw, ch);
    islands.update(simTime);
    tod.update(clamped);
    // Real diver threat (entities/diver/**) — species-differentiated flee response
    // (entities/fish/behavior.ts) now reacts to the actual diver position/speed, not a stand-in.
    // `window.__fishDebugDiver` stays as a fallback for verification scripts that want to inject a
    // synthetic diver without actually driving the dive flow (test/capture-fish-screenshots.mjs);
    // it only applies while nobody is really diving.
    //
    // `focus` — the point fish population activates around (entities/fish/index.ts's
    // updateResidents/manageRoamers) — follows the diver while diving. Before this, it was always
    // `curState` (the boat), so swimming away from an anchored boat left the diver in dead water:
    // the legacy `managePopulation`-around-the-boat bug docs/ARCHITECTURE.md's "Resident schools"
    // section calls out, reintroduced for the diver the moment entities/diver/** existed. The
    // boat's own position/speed is always passed separately as `boatThreat` — the hull is a real,
    // standing threat to nearby fish whether or not its driver is currently over the side.
    const diverState = diver.state;
    const boatThreat: Threat = { x: curState.x, z: curState.z, kind: 'boat', speed: Math.abs(curState.speed) };
    let focus = { x: curState.x, z: curState.z };
    let fishThreats: Threat[] = [];
    if (diver.mode === 'diver' && diverState) {
      focus = { x: diverState.x, z: diverState.z };
      fishThreats = [{ x: diverState.x, z: diverState.z, kind: 'diver', speed: Math.hypot(diverState.vx, diverState.vy, diverState.vz) }];
    } else {
      const debugDiver = (window as unknown as { __fishDebugDiver?: { x: number; z: number } }).__fishDebugDiver;
      if (debugDiver) fishThreats = [{ x: debugDiver.x, z: debugDiver.z, kind: 'diver', speed: 0.6 }];
    }
    fishWorld.update(clamped, simTime, focus, boatThreat, fishThreats);

    const amp = ampAt(renderState.x, renderState.z);
    applyBoatVisuals(renderState, model, { t: simTime, dt: clamped, todK: tod.getK(), sw, ch, amp, hull: { len: boatSpec.len, beam: boatSpec.beam, topMs: boatSpec.top * 0.5144 * SPEED_SCALE }, particles, water }, events);
    // Deck crew dance/brace/idle (entities/crew-model/dance.ts) — layered on top of model.group's
    // own heave/pitch/roll, which applyBoatVisuals just set for this frame. curState (not
    // renderState) for speed/steer/air: those are discrete/authoritative fields, same reasoning
    // as the interpolation comment above — they're never part of the lerped set anyway.
    crewSystem.update(clamped, simTime, { speed: curState.speed, steer: curState.steer, air: curState.air });

    particles.update(clamped, simTime, (x, z, t, a) => sampleWaterHeight(curState, x, z, t, a, sw, ch));
    catchFlow.updateReleased(clamped, simTime, (x, z, t) => sampleWaterHeight(curState, x, z, t, ampAt(x, z), sw, ch));

    for (const b of marinas.dockBoats) {
      b.position.y = sampleWaterHeight(curState, b.position.x, b.position.z, simTime, ampAt(b.position.x, b.position.z), sw, ch) - 0.05;
    }

    if (diver.mode === 'diver' && diverState) {
      // applyBoatVisuals above already kept the (drifting) boat's own transform/wake current —
      // just not its camera/HUD, which the diver owns while its driver is over the side.
      applyDiverVisuals(diverState, diverModel, diverEvents, { t: simTime });
      updateDiverCamera(camera, diver.cam, diverState, simTime, clamped);
      updateDiverHud(diverState, { canReboard: diver.canReboard });
      // entities/diver/model.ts's head/mask sit ~0.5-0.6 m in front of the model's own origin (so
      // chase view reads correctly) — exactly where the mask camera's forward view also looks, so
      // first-person mode was staring at the inside of its own face every frame (confirmed with a
      // raycast: nearest hit was the head sphere at 0.49 m). Hide the model in mask view, same as
      // every other first-person rig hides its own head; chase view wants it visible.
      diverModel.group.visible = diver.cam.mode === 'chase';
      // updateCamera (boat) does this itself at its own tail; updateDiverCamera doesn't, since it
      // has no idea the sky dome/sun disc exist — replicate it here so the sky stays centred on
      // the camera (and shadow frustums below see this frame's real matrixWorld) while diving too.
      camera.updateMatrixWorld(true);
      sceneCtx.sky.position.copy(camera.position);
      sceneCtx.sunDisc.position.copy(camera.position).addScaledVector(sunDir, 5000);
      sceneCtx.sunDisc.lookAt(camera.position);
    } else {
      updateCamera(clamped, { camera, sky: sceneCtx.sky, sunDisc: sceneCtx.sunDisc, sunDir }, camState, fpState, model, renderState, game.running, boatSpec.len);
      // DEV/VERIFICATION HOOK ONLY — lets a Playwright screenshot script place the camera directly
      // for entities/fish visual verification. Unset in every normal run, so this is a no-op outside
      // of test scripts. Applied after updateCamera so it wins for this frame instead of being
      // immediately overwritten.
      const camOverride = (window as unknown as {
        __fishDebugCamera?: { x: number; y: number; z: number; lookX: number; lookY: number; lookZ: number };
      }).__fishDebugCamera;
      if (camOverride) {
        camera.position.set(camOverride.x, camOverride.y, camOverride.z);
        camera.lookAt(camOverride.lookX, camOverride.lookY, camOverride.lookZ);
        camera.updateMatrixWorld(true);
      }
      electronics.update(clamped, simTime, fpState.driveOn);
      if (game.running) {
        updateHUD(clamped, curState, { boatLabel: hudBoatLabel(boatSpec), draft: boatSpec.draft, running: game.running });
        minimap.draw(simTime, curState);
        catchFlow.updateTouchDock(curState);
      }
    }
    // After the camera's final position for this frame (diver rig, boat rig, or the debug
    // override above) is set, so terrain chunks stream around wherever the viewer actually ended
    // up — otherwise a debug-placed or just-submerged camera would sit over unbuilt seabed.
    seafloor.update(camera.position);
    // Reef chunk residency follows the (now up-to-date) camera position — a no-op unless the
    // viewer crossed into a new 50 m chunk this frame; never a per-frame rebuild.
    reef.update(camera.position.x, camera.position.z);
    // Needs the final camera position to know the viewer's depth, and must run before anything
    // renders so the extinction/fog state is right for this frame.
    underwater.update(clamped);
    // Last: needs the model's and camera's matrixWorld both up to date (applyBoatVisuals /
    // updateCamera or updateDiverCamera above, plus any override), same as legacy's
    // `drawLine(time)` running after both `updateBoat`/`updateCamera`.
    fishing.render(simTime, curState, sw, ch);

    // Cascades reposition from the camera's up-to-date matrix (updateCamera just finalized it)
    // and the sun's current colour/intensity (time-of-day.ts mutated sceneCtx.sun above).
    shadows.setLight(sceneCtx.sun.color, sceneCtx.sun.intensity);
    shadows.update(sunDir);
    // Cheap (a handful of Box3/uniform updates) and keeps the per-material cameraNear/shadowFar
    // uniforms in sync with camera.near, which toggles between drive views (entities/camera.ts).
    shadows.updateFrustums();
    renderer.info.reset();
    postfx.render(clamped);
    // Real elapsed frame time (`dt`, pre-physics-clamp), not `clamped` — the latter is hard-capped
    // at 50 ms for the physics accumulator and would make the HUD misreport every real frame
    // slower than 20 fps as exactly 20 fps.
    profiler.sample(dt, renderer, quality.tier);
    // legacy `if(F.state==='caught') renderPortrait(time);` — an isolated off-screen render (see
    // game/catch/portrait.ts's header), run after the real frame so it never perturbs the
    // profiler's per-frame draw-call count sampled just above.
    if (FishF.state === 'caught') catchFlow.renderPortrait(simTime, renderer);
  }

  function resize(): void {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    postfx.setSize(w, h);
    shadows.updateFrustums();
  }

  // DEV/VERIFICATION HOOK ONLY — exposes the live, already-constructed `THREE.WebGLRenderer` so
  // game/catch/catch-flow.ts's `__catchPortraitDebug.renderFrame` (its own doc comment) can drive
  // the catch portrait's render loop from a script without playing out a real catch — a script
  // can't pass a live renderer instance across `page.evaluate`'s serialization boundary, so it
  // has to be found here instead. No normal code path reads `window.__renderer`.
  (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer = renderer;
  // DEV/VERIFICATION HOOK ONLY (see the __fishDebugDiver comment above frame()'s fishWorld.update
  // call) — lets test/capture-fish-screenshots.mjs find a deterministic resident of a given
  // species and teleport the boat there, instead of guessing world coordinates blind. No normal
  // code path reads `window.__fishDebug`.
  // DEV/VERIFICATION HOOK ONLY — world/underwater/index.ts's `debugCaustics()` doc comment.
  (window as unknown as { __uwInspect?: unknown }).__uwInspect = () => underwater.debugCaustics();
  (window as unknown as { __fishDebug?: unknown }).__fishDebug = {
    findResidentNear: fishWorld.findResidentNear,
    waterColumnAt: fishWorld.waterColumnAt,
    activeSchools: fishWorld.debugActiveSchools,
    poolStats: fishWorld.debugPoolStats,
    stats: () => fishWorld.stats,
    blowCount: fishWorld.debugBlowCount,
    teleport(x: number, z: number, h?: number): void {
      stateBox.state = { ...stateBox.state, x, z, h: h ?? stateBox.state.h, speed: 0 };
      curState = stateBox.state;
      model.group.position.set(x, stateBox.state.y, z);
      model.group.rotation.y = stateBox.state.h;
    },
    /** Verification-only: the boat's live x/z/heading/speed, so a screenshot script can position
     * a camera relative to a *moving* boat (e.g. entities/fish's dolphin bow-riding, which needs
     * real throttle input to demonstrate — teleport() above always zeroes speed) instead of
     * guessing where it ended up. No normal code path reads this. */
    boatState: () => ({ x: curState.x, z: curState.z, h: curState.h, speed: curState.speed }),
  };

  // DEV/VERIFICATION HOOK ONLY — same spirit as __fishDebug/__uwDebug above: this sandbox's
  // software-WebGL render rate makes a real-time dive through all five depth bands take minutes
  // of wall clock per leg (the fixed-step accumulator clamps to <=50ms of simulated time per
  // rendered frame — at a few fps that's a real, measured 10-40x slowdown, not a guess). The dive
  // *physics* is already proven by packages/shared/test/diver.test.ts's 20 unit tests; what a
  // screenshot script actually needs to verify is the *renderer* at a given depth, so this lets
  // one jump straight there instead of re-proving the descent every time. No normal code path
  // reads `window.__diverDebug`.
  (window as unknown as { __diverDebug?: unknown }).__diverDebug = {
    mode: () => diver.mode,
    state: () => diver.state,
    /** Jump in for real (same as pressing J) if not already diving, then snap straight to a given
     * depth/position — `diver.state`/`diver.cam` are live object references (controller.ts's
     * getters return the controller's own mutable state), so mutating the fields in place here
     * takes effect on the very next frame, same as any other physics step would. */
    enterAt(depth: number, x?: number, z?: number, yaw?: number): void {
      if (diver.mode === 'boat') {
        diver.enterWater(x ?? stateBox.state.x, z ?? stateBox.state.z, yaw ?? stateBox.state.h);
      }
      const s = diver.state;
      if (!s) return;
      if (x !== undefined) s.x = x;
      if (z !== undefined) s.z = z;
      s.y = -depth;
      s.vx = 0; s.vy = 0; s.vz = 0;
      if (yaw !== undefined) { s.yaw = yaw; diver.cam.yaw = yaw; }
    },
    setDepth(depth: number, zeroVelocity = true): void {
      const s = diver.state;
      if (!s) return;
      s.y = -depth;
      if (zeroVelocity) s.vy = 0;
    },
    setLook(yaw: number, pitch: number): void {
      diver.cam.yaw = yaw;
      diver.cam.pitch = pitch;
    },
    exitToBoat(): void { diver.exitToBoat(); },
  };

  return { resize, frame, renderer };

  function hudBoatLabel(spec: Boat): string {
    return (spec.nickname ? '"' + spec.nickname + '" · ' : '') + spec.brand + ' ' + spec.name + ' · ' + spec.power;
  }
}
